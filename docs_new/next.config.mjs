import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // This docs app is intentionally isolated from the stackbase backend workspace; pin Turbopack's
  // root to this directory so it doesn't infer the parent monorepo root from its lockfile.
  turbopack: {
    root: import.meta.dirname,
  },
  // The docs root has no page of its own (the old "home" duplicated
  // "What is stackbase?"). Send /docs to that page instead.
  async redirects() {
    return [
      {
        source: '/docs',
        destination: '/docs/get-started/what-is-stackbase',
        permanent: false,
      },
    ];
  },
};

export default withMDX(config);
