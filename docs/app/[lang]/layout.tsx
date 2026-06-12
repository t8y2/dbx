import type { ReactNode } from "react";
import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import { StaticSearchDialog } from "@/components/StaticSearchDialog";
import { i18nUI } from "@/lib/i18n";
import { SITE_URL, SITE_NAME, DEFAULT_DESCRIPTION } from "@/lib/metadata";

const LOCALE_MAP: Record<string, { locale: string; title: string; description: string }> = {
  en: {
    locale: "en_US",
    title: "DBX - 15 MB to manage 50+ databases",
    description: DEFAULT_DESCRIPTION,
  },
  cn: {
    locale: "zh_CN",
    title: "DBX - 15MB，管理50+种数据库",
    description: "50+ 种数据库，仅 15 MB。支持桌面与 Docker 自托管，内置 AI 助手。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = lang === "cn" ? "cn" : "en";
  const meta = LOCALE_MAP[l];

  return {
    title: {
      default: meta.title,
      template: `%s | ${SITE_NAME}`,
    },
    description: meta.description,
    openGraph: {
      locale: meta.locale,
      siteName: SITE_NAME,
      url: `${SITE_URL}/${l}`,
    },
    alternates: {
      canonical: `${SITE_URL}/${l}`,
      languages: {
        en: `${SITE_URL}/en`,
        zh: `${SITE_URL}/cn`,
        "x-default": `${SITE_URL}/en`,
      },
    },
  };
}

export default async function LangLayout({ params, children }: { params: Promise<{ lang: string }>; children: ReactNode }) {
  const { lang } = await params;

  return (
    <RootProvider
      i18n={i18nUI.provider(lang)}
      search={{
        SearchDialog: StaticSearchDialog,
      }}
      theme={{ defaultTheme: "system", enableSystem: true }}
    >
      {children}
    </RootProvider>
  );
}

export function generateStaticParams() {
  return [{ lang: "en" }, { lang: "cn" }];
}
