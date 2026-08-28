import { requestJson } from "./httpJson";

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

function changelogBaseUrl() {
  return (typeof process !== "undefined" && (process.env.NEXT_PUBLIC_CHANGELOG_BASE_URL || process.env.CHANGELOG_BASE_URL)) || DEFAULT_BASE_URL;
}

export function changelogUrl(lang: "en" | "cn") {
  return `${changelogBaseUrl()}/releases-${lang}.json`;
}

export function changelogIndexUrl(lang: "en" | "cn") {
  return `${changelogBaseUrl()}/index-${lang}.json`;
}

export function changelogReleaseUrl(lang: "en" | "cn", tag: string) {
  return `${changelogBaseUrl()}/releases-${lang}/${tag}.json`;
}

export async function fetchChangelog(lang: "en" | "cn"): Promise<ChangelogData> {
  return requestJson<ChangelogData>(changelogUrl(lang), { cache: "force-cache" });
}

export async function fetchChangelogIndex(lang: "en" | "cn"): Promise<ChangelogIndex> {
  return requestJson<ChangelogIndex>(changelogIndexUrl(lang), { cache: "force-cache" });
}

export async function fetchChangelogRelease(lang: "en" | "cn", tag: string): Promise<ChangelogRelease> {
  return requestJson<ChangelogRelease>(changelogReleaseUrl(lang, tag), { cache: "force-cache" });
}

export async function loadChangelogBootstrap(lang: "en" | "cn"): Promise<ChangelogBootstrap> {
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
