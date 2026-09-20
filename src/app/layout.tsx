import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'TrustGrid QC — Gate Inspection',
  description: 'Multimodal AI quality inspection at factory weighbridges',
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * Styling is deliberately minimal — the brief explicitly said not to spend
 * time on CSS. Everything below is functional affordance only.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        margin: 0, padding: '1rem', maxWidth: 780, marginInline: 'auto',
        lineHeight: 1.5, color: '#111',
      }}>
        {children}
      </body>
    </html>
  );
}
