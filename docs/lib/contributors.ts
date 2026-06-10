export type Contributor = {
  login: string;
  avatar_url: string;
  html_url: string;
  contributions: number;
  type?: string;
};

const GITHUB_CONTRIBUTORS_URL = "https://api.github.com/repos/t8y2/dbx/contributors?per_page=48";

function fallbackContributors(): Contributor[] {
  return [];
}

export async function fetchContributors(): Promise<Contributor[]> {
  try {
    const response = await fetch(GITHUB_CONTRIBUTORS_URL, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 60 * 60 * 6 },
    });

    if (!response.ok) return fallbackContributors();

    const data = (await response.json()) as Contributor[];
    if (!Array.isArray(data)) return fallbackContributors();

    return data.filter((c) => c.login && c.avatar_url && c.type !== "Bot");
  } catch {
    return fallbackContributors();
  }
}
