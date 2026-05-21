import { renderMermaidSVG } from 'beautiful-mermaid';

/**
 * Renders a Mermaid diagram to a themed SVG at render time (server component).
 * Used automatically for ```mermaid fences via the `remarkMdxMermaid` plugin
 * (see `source.config.ts`). Falls back to the raw source if a diagram can't parse.
 */
export function Mermaid({ chart }: { chart: string }) {
  try {
    const svg = renderMermaidSVG(chart, {
      bg: 'var(--color-fd-background)',
      fg: 'var(--color-fd-foreground)',
      interactive: true,
      transparent: true,
    });
    return <div className="my-6 flex justify-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
  } catch {
    return (
      <pre className="my-6 overflow-x-auto rounded-lg border p-4 text-sm">
        <code>{chart}</code>
      </pre>
    );
  }
}
