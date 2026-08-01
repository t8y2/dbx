import "../global.css";
import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import { StaticSearchDialog } from "@/components/StaticSearchDialog";
import { i18nUI } from "@/lib/i18n";
import { buildMetadata, DEFAULT_DESCRIPTION, getHtmlLang, SITE_NAME, SITE_URL } from "@/lib/metadata";
import { buildSiteStructuredData } from "@/lib/structuredData";

const LOCALE_MAP: Record<string, { locale: string; title: string; description: string }> = {
  en: {
    locale: "en_US",
    title: "DBX - 20 MB to manage 70+ databases",
    description: DEFAULT_DESCRIPTION,
  },
  cn: {
    locale: "zh_CN",
    title: "DBX - 20MB，管理70+种数据库",
    description: "70+ 种数据库，仅 20 MB。支持桌面与 Docker 自托管，内置 AI 助手。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = lang === "cn" ? "cn" : "en";
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
      icon: "/favicon.png",
      shortcut: "/favicon.png",
      apple: "/logo.png",
    },
    robots: { index: true, follow: true },
    openGraph: { ...pageMetadata.openGraph, locale: meta.locale },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b1120",
  colorScheme: "dark light",
};

export default async function LangLayout({ params, children }: { params: Promise<{ lang: string }>; children: ReactNode }) {
  const { lang } = await params;
  const locale = lang === "cn" ? "cn" : "en";
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
          <script key={structuredData["@id"]} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
        ))}
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider
          i18n={i18nUI.provider(locale)}
          search={{
            SearchDialog: StaticSearchDialog,
          }}
          theme={{ defaultTheme: "system", enableSystem: true }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}

export function generateStaticParams() {
  return [{ lang: "en" }, { lang: "cn" }];
}
