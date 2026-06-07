import type { Metadata } from 'next';

export const SITE_URL = 'https://dbxio.com';
export const SITE_NAME = 'DBX';
export const DEFAULT_DESCRIPTION =
  '25+ databases in 15 MB. Desktop & Docker self-hosting, with built-in AI assistant.';
export const DEFAULT_OG_IMAGE = '/logo.png';

const LOCALE_MAP: Record<string, string> = {
  en: 'en_US',
  cn: 'zh_CN',
};

const HTML_LANG_MAP: Record<string, string> = {
  en: 'en',
  cn: 'zh-CN',
};

export function getHtmlLang(lang: string): string {
  return HTML_LANG_MAP[lang] ?? 'en';
}

function swapLang(path: string, to: string): string {
  return path.replace(/^\/(en|cn)/, `/${to}`);
}

interface BuildMetadataParams {
  title: string;
  description: string;
  path: string;
  lang: string;
  ogType?: 'website' | 'article';
  images?: string[];
  lastModified?: Date;
}

export function buildMetadata({
  title,
  description,
  path,
  lang,
  ogType = 'website',
  images,
}: BuildMetadataParams): Metadata {
  const canonical = `${SITE_URL}${path}`;
  const locale = LOCALE_MAP[lang] ?? 'en_US';

  return {
    title,
    description,
    alternates: {
      canonical,
      languages: {
        en: `${SITE_URL}${swapLang(path, 'en')}`,
        zh: `${SITE_URL}${swapLang(path, 'cn')}`,
        'x-default': `${SITE_URL}${swapLang(path, 'en')}`,
      },
    },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: SITE_NAME,
      type: ogType,
      locale,
      images: images?.map((url) => ({ url })) ?? [{ url: DEFAULT_OG_IMAGE }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: images ?? [DEFAULT_OG_IMAGE],
    },
  };
}
