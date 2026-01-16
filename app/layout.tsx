import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'IEPA Document Summarizer',
  description: 'AI-powered environmental document analysis for Illinois EPA LUST and remediation files',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
