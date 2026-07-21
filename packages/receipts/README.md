# @helipod/receipts

Exactly-once mutation receipts for Helipod's durable offline outbox.

When a client with a durable outbox reconnects and resends queued mutations, the
server must execute each one exactly once even if the same mutation arrives twice.
Helipod does this with per-client receipts recorded atomically with each mutation's
own commit: a resend of an already-committed mutation is answered from its receipt
instead of being re-executed, and a per-client retention floor turns a receipt pruned
past retention into a loud terminal verdict rather than a silent re-execution.

The receipt storage contract lives on the document store itself; this package
provides the recurring background driver that periodically sweeps expired receipts
according to the retention policy.

> This is an internal package of the Helipod engine. Most applications should install
> [`helipod`](https://www.npmjs.com/package/helipod) instead.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
