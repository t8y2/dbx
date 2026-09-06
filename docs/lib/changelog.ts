import { requestJson } from "./httpJson";
import type { DocsLang } from "@/lib/i18n";

export type ChangelogItem = {
  title: string;
  desc: string;
};

export type ChangelogSection = {
  type: string;
  title: string;
  items: ChangelogItem[];
};

export type ChangelogRelease = {
  tag: string;
  name: string;
  date: string;
  markdown?: string;
  sections: ChangelogSection[];
};

export type ChangelogData = {
  updatedAt: string;
  releases: ChangelogRelease[];
};

export type ChangelogIndexEntry = {
  tag: string;
  name: string;
  date: string;
};

export type ChangelogIndex = {
  updatedAt: string;
  releases: ChangelogIndexEntry[];
};

export type ChangelogBootstrap = {
  index: ChangelogIndexEntry[];
  initialRelease: ChangelogRelease | null;
  // index-cn.json 与 releases-cn/ 尚未发布到 R2 时，退回全量 releases JSON，
  // 并把全量数据交给客户端按需取用，避免逐版本请求 404。
  fallbackReleases: ChangelogRelease[] | null;
};

const DEFAULT_BASE_URL = "https://dl.dbxio.com/changelog";

/**
 * Release notes are published to R2 as `releases-en.json` / `releases-cn.json`
 * only, so locales without their own feed read the English one while the page
 * chrome around them stays localized.
 */
export type ChangelogLang = "en" | "cn";

export function changelogDataLang(lang: DocsLang): ChangelogLang {
  return lang === "cn" ? "cn" : "en";
}

function changelogBaseUrl() {
  return (typeof process !== "undefined" && (process.env.NEXT_PUBLIC_CHANGELOG_BASE_URL || process.env.CHANGELOG_BASE_URL)) || DEFAULT_BASE_URL;
}

export function changelogUrl(lang: ChangelogLang) {
  return `${changelogBaseUrl()}/releases-${lang}.json`;
}

export function changelogIndexUrl(lang: ChangelogLang) {
  return `${changelogBaseUrl()}/index-${lang}.json`;
}

export function changelogReleaseUrl(lang: ChangelogLang, tag: string) {
  return `${changelogBaseUrl()}/releases-${lang}/${tag}.json`;
}

export async function fetchChangelog(lang: ChangelogLang): Promise<ChangelogData> {
  return requestJson<ChangelogData>(changelogUrl(lang), { cache: "force-cache" });
}

export async function fetchChangelogIndex(lang: ChangelogLang): Promise<ChangelogIndex> {
  return requestJson<ChangelogIndex>(changelogIndexUrl(lang), { cache: "force-cache" });
}

export async function fetchChangelogRelease(lang: ChangelogLang, tag: string): Promise<ChangelogRelease> {
  return requestJson<ChangelogRelease>(changelogReleaseUrl(lang, tag), { cache: "force-cache" });
}

export async function loadChangelogBootstrap(lang: ChangelogLang): Promise<ChangelogBootstrap> {
  try {
    const index = await fetchChangelogIndex(lang);
    if (index.releases.length > 0) {
      const initialRelease = await fetchChangelogRelease(lang, index.releases[0].tag);
      return { index: index.releases, initialRelease, fallbackReleases: null };
    }
  } catch {
    // fall through to the full listing
  }

  const full = await fetchChangelog(lang);
  return {
    index: full.releases.map(({ tag, name, date }) => ({ tag, name, date })),
    initialRelease: full.releases[0] ?? null,
    fallbackReleases: full.releases,
  };
}
