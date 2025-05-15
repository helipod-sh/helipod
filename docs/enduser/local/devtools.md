---
title: DevTools
---

# DevTools

> In-app overlay for high-signal debugging of operations, subscriptions, logs, and performance.

The DevTools overlay provides real-time visibility into your app's Stackbase activity during development.

## What DevTools shows

- **Activity** - Unified queries/mutations/actions with status, duration, and details
- **Subscriptions** - Active subscription list with update counts and context
- **Performance** - Latency percentiles, trends, and slowest operations
- **Logs** - Captured log lines with links back to related operations
- **Errors** - Failed operations surfaced directly in the activity stream

## Installation

```bash
npm install @stackbase/devtools
```

## Vite setup (recommended)

Add the plugin to your Vite config:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { stackbaseDevTools } from "@stackbase/devtools/vite";

export default defineConfig({
  plugins: [
    react(),
    stackbaseDevTools({
      position: "bottom-right", // or "bottom-left", "top-right", "top-left"
    }),
  ],
});
```

The plugin automatically:
- Injects the DevTools UI in development mode
- Excludes DevTools from production builds
- Handles hot module replacement

## Manual setup

If you're not using Vite, initialize DevTools manually:

```ts
// src/main.tsx or src/index.tsx
import { initDevTools } from "@stackbase/devtools/client";

// Only in development
if (import.meta.env.DEV) {
  initDevTools({
    position: "bottom-right",
  });
}
```

## Usage

### Toggle the panel

Use the keyboard shortcut to show/hide DevTools:

```
Cmd/Ctrl + Shift + D
```

Or click the floating button in the corner of your app.

### Activity panel

Use the Activity tab as the primary debugger:

- Filter by operation type (`all`, `query`, `mutation`, `action`, `error`)
- Search by function path with `Cmd/Ctrl + K`
- Search by IDs, args, results, errors, and log output
- Inspect arguments, results, errors, and log lines in the details pane
- Jump through recent operations with arrow keys + `Enter`
- Load older matching events in 100-event increments

### Subscriptions panel

Track live query subscriptions:

- Current subscription state
- Update counts and timestamps
- Function path and component context

### Performance and logs

Use **Performance** for latency analysis and **Logs** for execution output:

- Percentiles and trend sparklines by operation type
- Slowest operations list for bottleneck triage
- Click a slow operation to jump to the matching Activity event
- Log filtering + search by related operation path/ID
- Quick navigation from logs back to related activity events

## Configuration options

```ts
stackbaseDevTools({
  // Enable devtools (default: true in dev mode)
  enabled: true,

  // Position of the floating button and panel
  position: "bottom-right", // or "bottom-left", "top-right", "top-left"
})
```

## Disabling in production

### Vite plugin

The Vite plugin automatically disables in production. No extra config needed.

### Manual setup

Wrap initialization in a development check:

```ts
if (process.env.NODE_ENV === "development") {
  initDevTools({ position: "bottom-right" });
}
```

Or use dynamic imports to exclude from bundles:

```ts
if (import.meta.env.DEV) {
  import("@stackbase/devtools/client").then(({ initDevTools }) => {
    initDevTools({ position: "bottom-right" });
  });
}
```

## Performance notes

DevTools adds minimal overhead in development:

- Listens to existing Convex client events
- Stores recent operations in memory (capped)
- UI renders only when panel is open

For very high-frequency applications, you can disable DevTools temporarily by setting `enabled: false`.

## Troubleshooting

### DevTools not appearing

1. Check that the package is installed: `npm ls @stackbase/devtools`
2. Verify Vite plugin is in the plugins array
3. Ensure you're running in development mode
4. Check browser console for errors

### Panel is empty

1. Verify your app has active queries (use `useQuery`)
2. Check that the Convex client is connected
3. Try triggering a mutation to see activity

### Keyboard shortcut not working

1. Ensure focus is on the page (not DevTools/console)
2. Check for conflicting shortcuts from browser extensions
3. Use the floating button as alternative

## Common questions

- **Does this run in production?** No, the Vite plugin automatically excludes it. Manual setups should check `NODE_ENV`.
- **Does it affect performance?** Minimal in dev; zero in production (code isn't included).
- **Can I customize the UI?** Not currently; for deep debugging use the local dashboard instead.
- **Does it work with React Native?** Not yet; web only for now.
- **How do I see server-side logs?** DevTools shows client-side activity; check terminal or dashboard for server logs.

---

