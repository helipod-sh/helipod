/**
 * A collection of `KeyRange`s each carrying a value, with fast overlap queries and incremental
 * insert/delete. Bucketed by keyspace (a write range can only overlap read ranges in the SAME
 * keyspace); within a keyspace, an augmented interval tree (a treap keyed by `start`, each node
 * augmented with its subtree's max `end`, `null` = +∞). Priorities are a deterministic hash of the
 * entry's identity, so the tree shape is a pure function of its contents (reproducible) while
 * staying balanced in expectation regardless of insertion order. Overlap uses `rangesOverlap`
 * verbatim, so `[start, end)` half-open + `null`-end (+∞) semantics match the rest of the codec.
 */
import { compareKeyBytes } from "./encode";
import { rangesOverlap, type KeyRange } from "./range";

interface Node<V> {
  start: Uint8Array;
  end: Uint8Array | null; // exclusive; null = +∞
  value: V;
  valueKey: string;
  priority: number;
  maxEnd: Uint8Array | null; // subtree max end; null = +∞ present in subtree
  left: Node<V> | null;
  right: Node<V> | null;
}

/** FNV-1a 32-bit over (start, end-or-∞marker, valueKey) — deterministic, well-distributed. */
function hashPriority(start: Uint8Array, end: Uint8Array | null, valueKey: string): number {
  let h = 0x811c9dc5;
  const mix = (byte: number): void => {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (const byte of start) mix(byte);
  mix(0x00);
  if (end === null) mix(0xff);
  else for (const byte of end) mix(byte);
  mix(0x00);
  for (let i = 0; i < valueKey.length; i++) mix(valueKey.charCodeAt(i) & 0xff);
  return h >>> 0;
}

/** `null` end = +∞ dominates any concrete key. */
function maxEnd2(a: Uint8Array | null, b: Uint8Array | null): Uint8Array | null {
  if (a === null || b === null) return null;
  return compareKeyBytes(a, b) >= 0 ? a : b;
}

/** Total order on entries so `(start,end,valueKey)` triples are addressable. `null` end sorts last. */
function cmpEntry<V>(
  aStart: Uint8Array, aEnd: Uint8Array | null, aKey: string,
  node: Node<V>,
): -1 | 0 | 1 {
  const cs = compareKeyBytes(aStart, node.start);
  if (cs !== 0) return cs;
  if (aEnd === null || node.end === null) {
    if (aEnd !== node.end) return aEnd === null ? 1 : -1; // one is +∞
  } else {
    const ce = compareKeyBytes(aEnd, node.end);
    if (ce !== 0) return ce;
  }
  if (aKey < node.valueKey) return -1;
  if (aKey > node.valueKey) return 1;
  return 0;
}

function recalcMax<V>(n: Node<V>): void {
  let m = n.end;
  if (n.left) m = maxEnd2(m, n.left.maxEnd);
  if (n.right) m = maxEnd2(m, n.right.maxEnd);
  n.maxEnd = m;
}

function rotateRight<V>(n: Node<V>): Node<V> {
  const l = n.left!;
  n.left = l.right;
  l.right = n;
  recalcMax(n);
  recalcMax(l);
  return l;
}

function rotateLeft<V>(n: Node<V>): Node<V> {
  const r = n.right!;
  n.right = r.left;
  r.left = n;
  recalcMax(n);
  recalcMax(r);
  return r;
}

/** One keyspace's augmented interval treap. */
class Treap<V> {
  root: Node<V> | null = null;
  size = 0;

  insert(start: Uint8Array, end: Uint8Array | null, value: V, valueKey: string): void {
    // `size` is bumped inside insertAt only on a genuine new node (idempotent on duplicates).
    this.root = this.insertAt(this.root, start, end, value, valueKey);
  }

  private insertAt(
    node: Node<V> | null, start: Uint8Array, end: Uint8Array | null, value: V, valueKey: string,
  ): Node<V> {
    if (node === null) {
      this.size++;
      return { start, end, value, valueKey, priority: hashPriority(start, end, valueKey), maxEnd: end, left: null, right: null };
    }
    const c = cmpEntry(start, end, valueKey, node);
    if (c === 0) return node; // idempotent: identical (bounds,value)
    if (c < 0) {
      node.left = this.insertAt(node.left, start, end, value, valueKey);
      if (node.left.priority > node.priority) node = rotateRight(node);
    } else {
      node.right = this.insertAt(node.right, start, end, value, valueKey);
      if (node.right.priority > node.priority) node = rotateLeft(node);
    }
    recalcMax(node);
    return node;
  }

  remove(start: Uint8Array, end: Uint8Array | null, valueKey: string): void {
    // `size` is decremented inside removeAt only when a node is actually removed.
    this.root = this.removeAt(this.root, start, end, valueKey);
  }

  private removeAt(node: Node<V> | null, start: Uint8Array, end: Uint8Array | null, valueKey: string): Node<V> | null {
    if (node === null) return null;
    const c = cmpEntry(start, end, valueKey, node);
    if (c < 0) node.left = this.removeAt(node.left, start, end, valueKey);
    else if (c > 0) node.right = this.removeAt(node.right, start, end, valueKey);
    else {
      if (node.left === null) { this.size--; return node.right; }
      if (node.right === null) { this.size--; return node.left; }
      if (node.left.priority > node.right.priority) {
        node = rotateRight(node);
        node.right = this.removeAt(node.right, start, end, valueKey);
      } else {
        node = rotateLeft(node);
        node.left = this.removeAt(node.left, start, end, valueKey);
      }
    }
    if (node) recalcMax(node);
    return node;
  }

  collect(keyspace: string, q: KeyRange, out: V[]): void {
    this.collectAt(this.root, keyspace, q, out);
  }

  private collectAt(node: Node<V> | null, keyspace: string, q: KeyRange, out: V[]): void {
    if (node === null) return;
    // Prune: if the whole subtree's max end cannot exceed q.start, nothing overlaps (half-open).
    if (node.maxEnd !== null && compareKeyBytes(node.maxEnd, q.start) <= 0) return;
    this.collectAt(node.left, keyspace, q, out);
    if (rangesOverlap({ keyspace, start: node.start, end: node.end }, q)) out.push(node.value);
    // Right subtree starts are >= node.start; overlap needs start < q.end.
    if (q.end === null || compareKeyBytes(node.start, q.end) < 0) this.collectAt(node.right, keyspace, q, out);
  }
}

export class IntervalIndex<V> {
  private readonly byKeyspace = new Map<string, Treap<V>>();
  private readonly valueKey: (v: V) => string;

  constructor(valueKey: (v: V) => string = (v) => String(v)) {
    this.valueKey = valueKey;
  }

  insert(range: KeyRange, value: V): void {
    let tree = this.byKeyspace.get(range.keyspace);
    if (!tree) { tree = new Treap<V>(); this.byKeyspace.set(range.keyspace, tree); }
    tree.insert(range.start, range.end, value, this.valueKey(value));
  }

  remove(range: KeyRange, value: V): void {
    const tree = this.byKeyspace.get(range.keyspace);
    if (!tree) return;
    tree.remove(range.start, range.end, this.valueKey(value));
    if (tree.size === 0) this.byKeyspace.delete(range.keyspace);
  }

  queryOverlaps(range: KeyRange): V[] {
    const tree = this.byKeyspace.get(range.keyspace);
    if (!tree) return [];
    const out: V[] = [];
    tree.collect(range.keyspace, range, out);
    return out;
  }

  get size(): number {
    let n = 0;
    for (const tree of this.byKeyspace.values()) n += tree.size;
    return n;
  }
}
