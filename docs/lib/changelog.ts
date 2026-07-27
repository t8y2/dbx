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
  sections: ChangelogSection[];
};

export type ChangelogData = {
  updatedAt: string;
  releases: ChangelogRelease[];
};

const DEFAULT_BASE_URL = "https://dl.dbxio.com/changelog";

export function changelogUrl(lang: "en" | "cn") {
  const baseUrl = (typeof process !== "undefined" && (process.env.NEXT_PUBLIC_CHANGELOG_BASE_URL || process.env.CHANGELOG_BASE_URL)) || DEFAULT_BASE_URL;

  return `${baseUrl}/releases-${lang}.json`;
}

export async function fetchChangelog(lang: "en" | "cn"): Promise<ChangelogData> {
  return requestJson<ChangelogData>(changelogUrl(lang), { cache: "force-cache" });
}
