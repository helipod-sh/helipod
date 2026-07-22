/**
 * The helipod terminal theme — the website's dark palette (`website/app/global.css`
 * `.dark` fumadocs tokens), converted from oklch to terminal hex. The terminal
 * dashboard is the same brand surface as helipod.dev, not a stock TUI theme.
 */
import { createTheme } from "@/components/ui/theme-provider";

export const helipodTheme = createTheme({
  name: "helipod-dark",
  colors: {
    background: "#14110e", // --color-fd-background (dark)
    foreground: "#f2eee9", // --color-fd-foreground
    muted: "#1c1714", //      --color-fd-card
    mutedForeground: "#968d88", // --color-fd-muted-foreground
    border: "#332c28", //     --color-fd-border
    primary: "#e04667", //    --color-fd-primary — the helipod crimson
    primaryForeground: "#fdf6f4",
    accent: "#472025", //     --color-fd-accent (crimson-tinted surface)
    accentForeground: "#eba3ae",
    secondary: "#2a241f",
    secondaryForeground: "#d9d2ca",
    selection: "#472025",
    selectionForeground: "#f2eee9",
    focusRing: "#e04667",
    success: "#7ec699",
    successForeground: "#10140f",
    warning: "#e3b341",
    warningForeground: "#171204",
    error: "#ff7b72",
    errorForeground: "#1a0b0a",
    info: "#79b8ff",
    infoForeground: "#0a1017",
  },
});
