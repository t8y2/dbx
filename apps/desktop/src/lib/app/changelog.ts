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
  sections: ChangelogSection[];
};

/** One row of the published changelog index: no release body. */
export type ChangelogReleaseSummary = {
  tag: string;
  name: string;
  date: string;
};

export type ChangelogIndexData = {
  updatedAt: string;
  releases: ChangelogReleaseSummary[];
};

export type ChangelogData = {
  updatedAt: string;
  releases: ChangelogRelease[];
};

export type ChangelogLang = "en" | "cn";

const feedCache = new Map<ChangelogLang, Promise<ChangelogData>>();
const indexCache = new Map<ChangelogLang, Promise<ChangelogIndexData>>();
const releaseCache = new Map<string, Promise<ChangelogRelease>>();

function releaseCacheKey(lang: ChangelogLang, tag: string) {
  return `${lang}\u0000${tag}`;
}

/**
 * Drop cached changelog payloads so the next read goes back to R2. A release
 * body is cached per tag, so clearing one language has to clear each of its tags.
 */
export function clearChangelogCache(lang?: ChangelogLang) {
  if (!lang) {
    feedCache.clear();
    indexCache.clear();
    releaseCache.clear();
    return;
  }
  feedCache.delete(lang);
  indexCache.delete(lang);
  const prefix = `${lang}\u0000`;
  // Map iterators tolerate deleting the entry being visited.
  for (const key of releaseCache.keys()) {
    if (key.startsWith(prefix)) releaseCache.delete(key);
  }
}

export function createLatestRequestGuard() {
  let latestRequestId = 0;
  return {
    begin: () => ++latestRequestId,
    isCurrent: (requestId: number) => requestId === latestRequestId,
  };
}

export function changelogLangFromLocale(locale: string): ChangelogLang {
  return locale === "zh-CN" || locale === "zh-TW" ? "cn" : "en";
}

export function changelogWebsiteUrl(lang: ChangelogLang): string {
  return `https://dbxio.com/${lang}/changelog`;
}

export function changelogReleaseUrl(tag: string): string {
  return `https://github.com/t8y2/dbx/releases/tag/${encodeURIComponent(tag)}`;
}

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>, force: boolean): Promise<T> {
  if (force) cache.delete(key);
  let pending = cache.get(key);
  if (!pending) {
    pending = load().catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
  }
  return pending;
}

/**
 * Version list only (`changelog/index-<lang>.json`, a few kilobytes). The full
 * feed carries every release body and is megabytes, so any UI that only lists
 * versions reads the index instead of downloading all release notes.
 */
export async function fetchChangelogIndex(lang: ChangelogLang, options: { force?: boolean } = {}): Promise<ChangelogIndexData> {
  return cached(indexCache, lang, () => loadChangelogIndex(lang), options.force === true);
}

/** Release body for one version (`changelog/releases-<lang>/<tag>.json`). */
export async function fetchChangelogRelease(lang: ChangelogLang, tag: string, options: { force?: boolean } = {}): Promise<ChangelogRelease> {
  return cached(releaseCache, releaseCacheKey(lang, tag), () => loadChangelogRelease(lang, tag), options.force === true);
}

/** Full feed in one request; kept for callers that need every release body at once. */
export async function fetchChangelog(lang: ChangelogLang, options: { force?: boolean } = {}): Promise<ChangelogData> {
  return cached(feedCache, lang, () => loadChangelog(lang), options.force === true);
}

async function loadChangelogIndex(lang: ChangelogLang): Promise<ChangelogIndexData> {
  const { fetchChangelogIndex: fetchIndexViaBackend } = await import("@/lib/backend/api");
  const data = await fetchIndexViaBackend(lang);
  if (!data || !Array.isArray(data.releases)) {
    throw new Error("Invalid changelog index payload");
  }

  return {
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
    releases: data.releases.filter((release) => release && typeof release.tag === "string"),
  };
}

async function loadChangelogRelease(lang: ChangelogLang, tag: string): Promise<ChangelogRelease> {
  const { fetchChangelogRelease: fetchReleaseViaBackend } = await import("@/lib/backend/api");
  const data = await fetchReleaseViaBackend(lang, tag);
  if (!data || typeof data.tag !== "string") {
    throw new Error("Invalid changelog release payload");
  }

  return {
    tag: data.tag,
    name: typeof data.name === "string" ? data.name : "",
    date: typeof data.date === "string" ? data.date : "",
    sections: Array.isArray(data.sections) ? data.sections.filter((section) => section && Array.isArray(section.items)) : [],
  };
}

async function loadChangelog(lang: ChangelogLang): Promise<ChangelogData> {
  const { fetchChangelog: fetchChangelogViaBackend } = await import("@/lib/backend/api");
  const data = await fetchChangelogViaBackend(lang);
  if (!data || !Array.isArray(data.releases)) {
    throw new Error("Invalid changelog payload");
  }

  return {
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
    releases: data.releases.filter((release) => release && typeof release.tag === "string"),
  };
}
