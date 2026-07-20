import "./global.css";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import { SITE_URL, SITE_NAME, DEFAULT_DESCRIPTION, DEFAULT_OG_IMAGE } from "@/lib/metadata";

export const metadata: Metadata = {
  title: {
    default: SITE_NAME,
    template: `%s | ${SITE_NAME}`,
  },
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

const WEBSITE_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: SITE_NAME,
  url: SITE_URL,
  description: DEFAULT_DESCRIPTION,
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: `${SITE_URL}/search?q={search_term_string}`,
    },
    "query-input": "required name=search_term_string",
  },
} as const;

const SOFTWARE_APP_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  url: SITE_URL,
  description: DEFAULT_DESCRIPTION,
  applicationCategory: "Database Management",
  operatingSystem: ["Windows", "macOS", "Linux", "Docker"],
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  author: {
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
  },
  releaseNotes: `${SITE_URL}/en/changelog`,
  screenshot: `${SITE_URL}/screenshot-dark.png`,
  featureList: [
    "60+ database engines (MySQL, PostgreSQL, SQLite, Redis, MongoDB, DuckDB, ClickHouse, SQL Server, Oracle, and many more)",
    "AI-powered SQL generation and explanation",
    "MCP Server integration for AI coding agents",
    "Schema browser and diff tools",
    "Data grid with inline editing",
    "SSH tunnel support",
    "Docker self-hosting",
  ],
} as const;

const ORG_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: SITE_NAME,
  url: SITE_URL,
  description: DEFAULT_DESCRIPTION,
  sameAs: [
    "https://github.com/t8y2/dbx",
    "https://www.npmjs.com/package/@dbx-app/mcp-server",
  ],
} as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html suppressHydrationWarning>
      <head>
        <script
          defer
          src="https://analytics.unihub.top/script.js"
          data-website-id="69afbe68-e06e-4fa8-84cd-e47d6d44baf0"
          data-domains="dbxio.com,www.dbxio.com"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(WEBSITE_SCHEMA) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(SOFTWARE_APP_SCHEMA) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ORG_SCHEMA) }}
        />
      </head>
      <body className="flex min-h-screen flex-col">{children}</body>
    </html>
  );
}
