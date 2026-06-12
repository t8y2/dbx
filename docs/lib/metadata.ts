import type { Metadata } from "next";

export const SITE_URL = "https://dbxio.com";
export const SITE_NAME = "DBX";
export const DEFAULT_DESCRIPTION = "50+ databases in 15 MB. Desktop & Docker self-hosting, with built-in AI assistant.";
export const DEFAULT_OG_IMAGE = "/logo.png";

const LOCALE_MAP: Record<string, string> = {
  en: "en_US",
  cn: "zh_CN",
};

const HTML_LANG_MAP: Record<string, string> = {
  en: "en",
  cn: "zh-CN",
};

export function getHtmlLang(lang: string): string {
  return HTML_LANG_MAP[lang] ?? "en";
}

function swapLang(path: string, to: string): string {
  return path.replace(/^\/(en|cn)/, `/${to}`);
}

interface BuildMetadataParams {
  title: string;
  description: string;
  path: string;
  lang: string;
  ogType?: "website" | "article";
  images?: string[];
  lastModified?: Date;
}

export function buildMetadata({
  title,
  description,
  path,
  lang,
  ogType = "website",
  images,
  lastModified,
}: BuildMetadataParams): Metadata {
  const canonical = `${SITE_URL}${path}`;
  const locale = LOCALE_MAP[lang] ?? "en_US";
  const ogImages = images?.map((url) => ({
    url,
    width: url === DEFAULT_OG_IMAGE ? 512 : 1200,
    height: url === DEFAULT_OG_IMAGE ? 512 : 630,
  })) ?? [{ url: DEFAULT_OG_IMAGE, width: 512, height: 512 }];

  const base: Metadata = {
    title,
    description,
    alternates: {
      canonical,
      languages: {
        en: `${SITE_URL}${swapLang(path, "en")}`,
        zh: `${SITE_URL}${swapLang(path, "cn")}`,
        "x-default": `${SITE_URL}${swapLang(path, "en")}`,
      },
    },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: SITE_NAME,
      type: ogType,
      locale,
      images: ogImages,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: images ?? [DEFAULT_OG_IMAGE],
    },
    other: {
      "og:image:alt": title,
    },
  };

  if (lastModified) {
    base.other = { ...base.other, "article:modified_time": lastModified.toISOString() };
  }

  return base;
}
