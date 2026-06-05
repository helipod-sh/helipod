import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';

// Both doc trees as explicit tab options. The main docs tree isn't a
// `root: true` folder, so on its own the sidebar shows only a static label
// with no way to reach Contributing. Listing both here makes the sidebar's
// tab selector appear on every page and switch between the two. Plain
// `{ title, url }` options are used deliberately: a `$folder`-bound option
// (from getLayoutTabs) does not survive the server/client boundary and the
// tab silently drops. The actual per-tab sidebar tree is still segmented by
// the `root: true` flag on the Contributing folder, independent of this list.
// Order matters: Contributing is last so it wins active-detection (findLast)
// on its own pages, where both `/docs` and `/docs/contributing` are prefixes.
const tabs = [
  { title: 'stackbase', url: '/docs' },
  { title: 'Contributing', url: '/docs/contributing' },
];

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout tree={source.getPageTree()} {...baseOptions()} sidebar={{ tabs }}>
      {children}
    </DocsLayout>
  );
}
