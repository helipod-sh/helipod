import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';
import { JetBrains_Mono, Inter } from 'next/font/google';

// Coral is single-family Inter (display + body) plus a mono for code tiles,
// exposed as CSS variables the scoped `.lp` styles consume.
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-jetbrains-mono',
});
const inter = Inter({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-inter' });

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <HomeLayout {...baseOptions()}>
      <div className={`${inter.variable} ${jetbrainsMono.variable}`}>{children}</div>
    </HomeLayout>
  );
}
