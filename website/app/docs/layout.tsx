import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import { Layers, Blocks } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

// Wrap a tab icon exactly the way fumadocs' own root-folder tabs do: the svg
// fills the slot on desktop (the outer size-5 box) and becomes a tinted,
// bordered box on mobile (size-9). This is what the built-in tab generator's
// default transform produces; we reproduce it here because we build the tabs
// by hand (see the note on `tabs` below).
function tabIcon(icon: ReactNode): ReactNode {
  return (
    <div
      className="[&_svg]:size-full rounded-lg size-full text-(--tab-color) max-md:bg-(--tab-color)/10 max-md:border max-md:p-1.5"
      style={{ '--tab-color': 'var(--color-fd-foreground)' } as CSSProperties}
    >
      {icon}
    </div>
  );
}

// Both doc trees as explicit tab options. The main docs tree isn't a
// `root: true` folder, so on its own the sidebar shows only a static label
// with no way to reach Contributing. Listing both here makes the sidebar's
// tab selector appear on every page and switch between the two. Plain
// options are used deliberately: a `$folder`-bound option (from
// getLayoutTabs) does not survive the server/client boundary and the tab
// silently drops. The actual per-tab sidebar tree is still segmented by the
// `root: true` flag on the Contributing folder, independent of this list.
// Order matters: Contributing is last so it wins active-detection (findLast)
// on its own pages, where both `/docs` and `/docs/contributing` are prefixes.
const tabs = [
  {
    title: 'stackbase',
    description: 'Guides and reference',
    url: '/docs',
    icon: tabIcon(<Layers />),
  },
  {
    title: 'Contributing',
    description: 'How stackbase is built',
    url: '/docs/contributing',
    icon: tabIcon(<Blocks />),
  },
];

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout tree={source.getPageTree()} {...baseOptions()} sidebar={{ tabs }}>
      {children}
    </DocsLayout>
  );
}
