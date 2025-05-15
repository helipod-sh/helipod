---
title: Local Dashboard
---

# Local Dashboard

> Browse tables, run functions, and inspect data in the built-in dashboard.

The local dashboard provides a web UI for exploring your Stackbase database during development.

## Open the dashboard

When the dev server is running, visit:

```
http://localhost:<port>/_dashboard
```

The CLI prints the exact URL when it starts:

```
$ npx stackbase dev
Stackbase dev server running at http://localhost:3000
Dashboard: http://localhost:3000/_dashboard
```

## Features

### Data browser

Browse all tables in your database:

- **View documents** - See all documents in a table with their fields
- **Filter and search** - Find specific documents by field values
- **Pagination** - Navigate through large tables
- **Document details** - Click a document to see all fields including `_id` and `_creationTime`

#### Filtering documents

Use the filter bar to narrow results:

1. Select a table from the sidebar
2. Click the filter icon or use the filter input
3. Enter a field name and value (e.g., `status:active`)
4. Press Enter to apply

#### Editing documents

To modify a document:

1. Click on a document row to expand it
2. Click the "Edit" button
3. Modify field values in the JSON editor
4. Click "Save" to apply changes

**Note**: Edits are real mutations that affect your database.

### Function runner

Execute functions directly from the dashboard:

- **Queries** - Run queries and see results
- **Mutations** - Execute mutations with arguments
- **Actions** - Trigger actions and view outputs
- **Argument input** - JSON editor for function arguments

### Schema viewer

Inspect your schema definition:

- **Tables** - See all defined tables
- **Fields** - View field types and validators
- **Indexes** - Check index definitions

### System info

View runtime information:

- **Connection status** - WebSocket connection state
- **Runtime** - Which runtime is serving (Bun, Node, Cloudflare)
- **Version** - Stackbase version

## Building the dashboard

If you see a warning about missing dashboard assets:

```
Warning: Dashboard assets not found. Run 'bun run build:dashboard-local'
```

Build them once from the monorepo root:

```bash
bun run build:dashboard-local
```

Then restart the dev server.

## Security

> **Warning**: The dashboard provides unrestricted access to your entire database. Only use it in development environments.

The dashboard is intended for **local development only**. Exposing it in production creates serious security risks:

| Risk | Impact |
|------|--------|
| **Full database access** | Anyone can read, modify, or delete all data |
| **No authentication** | No login required by default |
| **Function execution** | Can run any query, mutation, or action |
| **No audit trail** | Actions aren't logged or attributed |

### Production recommendations

1. **Don't deploy dashboard assets** - The simplest protection is to exclude dashboard files from your production build
2. **Block the route** - If dashboard assets are included, block `/_dashboard` at your reverse proxy
3. **Add authentication** - If you need a production admin panel, build a custom one with proper auth

To disable the dashboard in production, don't include the dashboard assets in your deployment.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + K` | Open command palette |
| `Cmd/Ctrl + Enter` | Execute function |
| `Esc` | Close panels |

## Common questions

- **Is the dashboard available in production?** It's primarily for local dev; expose with care and consider security implications.
- **Can I customize the dashboard?** Not directly, but you can build custom admin UIs using the same Convex client APIs.
- **The dashboard is slow with large tables** - Use filters to limit results; full table scans on large datasets are expensive.
- **Can I edit documents directly?** Yes, you can modify document fields in the data browser (in development mode).

---

