import "../global.css";
import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { RouteProgress } from "@/components/RouteProgress";
import { buildMetadata, DEFAULT_DESCRIPTION, getHtmlLang, SITE_NAME, SITE_URL } from "@/lib/metadata";
import { buildSiteStructuredData, serializeStructuredData } from "@/lib/structuredData";
import { i18n, resolveLang } from "@/lib/i18n";

const LOCALE_MAP: Record<string, { locale: string; title: string; description: string }> = {
  en: {
    locale: "en_US",
    title: "DBX - 25 MB to manage 100+ databases",
    description: DEFAULT_DESCRIPTION,
  },
  cn: {
    locale: "zh_CN",
    title: "DBX - 25MB，管理100+种数据库",
    description: "DBX 是免费开源的数据库管理工具，支持 MySQL、PostgreSQL、SQLite、Redis 等 100+ 种数据系统，提供 SQL 编辑、AI 助手、MCP 与 Docker 自托管。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = resolveLang(lang);
  const meta = LOCALE_MAP[l];

  const pageMetadata = buildMetadata({
    title: meta.title,
    description: meta.description,
    path: `/${l}`,
    lang: l,
  });

  return {
    ...pageMetadata,
    title: {
      default: meta.title,
      template: `%s | ${SITE_NAME}`,
    },
    metadataBase: new URL(SITE_URL),
    icons: {
      icon: "/favicon-64.png",
      shortcut: "/favicon-64.png",
      apple: "/logo.png",
    },
    openGraph: { ...pageMetadata.openGraph, locale: meta.locale },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#161616",
  colorScheme: "dark light",
};

export default async function LangLayout({ params, children }: { params: Promise<{ lang: string }>; children: ReactNode }) {
  const { lang } = await params;
  const locale = resolveLang(lang);
  const siteStructuredData = buildSiteStructuredData();

  return (
    <html lang={getHtmlLang(locale)} suppressHydrationWarning>
      <head>
        <script
          defer
          src="https://analytics.unihub.top/script.js"
          data-website-id="69afbe68-e06e-4fa8-84cd-e47d6d44baf0"
          data-domains="dbxio.com,www.dbxio.com"
        />
        {siteStructuredData.map((structuredData) => (
          <script key={structuredData["@id"]} type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeStructuredData(structuredData) }} />
        ))}
      </head>
      <body className="flex min-h-screen flex-col">
        <RouteProgress />
        {children}
      </body>
    </html>
  );
}

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}
