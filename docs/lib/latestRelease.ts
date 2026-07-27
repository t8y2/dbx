import { requestJson } from "./httpJson";

export type LatestReleaseInfo = {
  version: string;
  notes?: string;
  pub_date?: string;
};

const LATEST_RELEASE_URL = "https://dl.dbxio.com/releases/latest/latest.json";

function normalizeVersion(version: string) {
  return version.replace(/^v/, "");
}

export async function fetchLatestReleaseInfo(): Promise<LatestReleaseInfo | null> {
  try {
    const release = await requestJson<LatestReleaseInfo>(LATEST_RELEASE_URL, {
      cache: "force-cache",
      headers: { Accept: "application/json" },
    });
    return release.version ? { ...release, version: normalizeVersion(release.version) } : null;
  } catch {
    return null;
  }
}
