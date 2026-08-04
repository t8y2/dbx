import "../global.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { DEFAULT_DESCRIPTION, DEFAULT_OG_IMAGE, SITE_NAME, SITE_URL } from "@/lib/metadata";

export const metadata: Metadata = {
  title: SITE_NAME,
  description: DEFAULT_DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  icons: {
    icon: "/favicon.png",
    shortcut: "/favicon.png",
    apple: "/logo.png",
  },
  openGraph: {
    siteName: SITE_NAME,
    images: [{ url: DEFAULT_OG_IMAGE }],
  },
  twitter: {
    card: "summary_large_image",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b1120",
  colorScheme: "dark light",
};

export default function RedirectRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="flex min-h-screen flex-col">{children}</body>
    </html>
  );
}
