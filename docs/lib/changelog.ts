import { requestJson } from "@/lib/httpJson";

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

type GitHubRelease = {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
};

const DEFAULT_BASE_URL = "https://dl.dbxio.com/changelog";
const GITHUB_RELEASES_URL = "https://api.github.com/repos/t8y2/dbx/releases?per_page=30";

const SECTION_MAP: Record<string, string> = {
  新功能: "added",
  Added: "added",
  改进: "improved",
  Improved: "improved",
  修复: "fixed",
  Fixed: "fixed",
  变更: "changed",
  Changed: "changed",
  移除: "removed",
  Removed: "removed",
};

export function changelogUrl(lang: "en" | "cn") {
  const baseUrl = (typeof process !== "undefined" && (process.env.NEXT_PUBLIC_CHANGELOG_BASE_URL || process.env.CHANGELOG_BASE_URL)) || DEFAULT_BASE_URL;

  return `${baseUrl}/releases-${lang}.json`;
}

export async function fetchChangelog(lang: "en" | "cn"): Promise<ChangelogData> {
  const url = changelogUrl(lang);

  try {
    return await requestJson<ChangelogData>(url);
  } catch {
    return fetchGitHubChangelog();
  }
}

function stripDownloadSection(body: string) {
  const markers = ["### 下载安装", "### Download", "### 系统要求", "### System Requirements"];
  let idx = body.length;

  for (const marker of markers) {
    const markerIndex = body.indexOf(marker);
    if (markerIndex !== -1 && markerIndex < idx) {
      idx = markerIndex;
    }
  }

  return body.slice(0, idx).trim();
}

function parseReleaseBody(body: string) {
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;

  for (const line of stripDownloadSection(body).split("\n")) {
    const headerMatch = line.match(/^###\s+(.+)/);
    if (headerMatch) {
      const title = headerMatch[1].trim();
      current = { type: SECTION_MAP[title] || "other", title, items: [] };
      sections.push(current);
      continue;
    }

    if (!current) continue;

    const itemMatch = line.match(/^-\s+\*\*(.+?)\*\*\s*[—–-]\s*(.+)/);
    if (itemMatch) {
      current.items.push({ title: itemMatch[1].trim(), desc: itemMatch[2].trim() });
      continue;
    }

    const plainMatch = line.match(/^-\s+(.+)/);
    if (plainMatch) {
      current.items.push({ title: plainMatch[1].trim(), desc: "" });
    }
  }

  return sections.filter((section) => section.items.length > 0);
}

export async function fetchGitHubChangelog(): Promise<ChangelogData> {
  try {
    const releases = await requestJson<GitHubRelease[]>(GITHUB_RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });

    return {
      updatedAt: new Date().toISOString(),
      releases: releases
        .filter((release) => !release.draft && !release.prerelease && !release.tag_name.startsWith("agents-"))
        .map((release) => ({
          tag: release.tag_name,
          name: release.name || release.tag_name,
          date: (release.published_at || "").slice(0, 10),
          sections: parseReleaseBody(release.body || ""),
        })),
    };
  } catch {
    return { updatedAt: "", releases: [] };
  }
}
