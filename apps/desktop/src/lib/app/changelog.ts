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

export type ChangelogData = {
  updatedAt: string;
  releases: ChangelogRelease[];
};

export type ChangelogLang = "en" | "cn";

const cache = new Map<ChangelogLang, Promise<ChangelogData>>();

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

export async function fetchChangelog(lang: ChangelogLang, options: { force?: boolean } = {}): Promise<ChangelogData> {
  if (options.force) {
    cache.delete(lang);
  }

  let pending = cache.get(lang);
  if (!pending) {
    pending = loadChangelog(lang).catch((error) => {
      cache.delete(lang);
      throw error;
    });
    cache.set(lang, pending);
  }

  return pending;
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
