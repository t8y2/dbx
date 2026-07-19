export type Contributor = {
  login: string;
  avatar_url: string;
  html_url: string;
  contributions: number;
  type?: string;
};

const GITHUB_CONTRIBUTORS_API = "https://api.github.com/repos/t8y2/dbx/contributors";

function parseNextLink(linkHeader: string): string | null {
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const [url, rel] = part.split(";").map((s) => s.trim());
    if (rel === 'rel="next"') {
      return url.slice(1, -1); // strip < >
    }
  }
  return null;
}

async function fetchPage(url: string, token?: string): Promise<{ data: Contributor[]; next: string | null }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    headers,
    next: { revalidate: 60 * 60 * 6 },
  });

  if (!response.ok) return { data: [], next: null };

  const data = (await response.json()) as Contributor[];
  if (!Array.isArray(data)) return { data: [], next: null };

  const linkHeader = response.headers.get("Link");
  const next = linkHeader ? parseNextLink(linkHeader) : null;

  return { data, next };
}

function fallbackContributors(): Contributor[] {
  return [
    { login: "t8y2", avatar_url: "https://avatars.githubusercontent.com/u/77960507", html_url: "https://github.com/t8y2", contributions: 1601 },
    { login: "Illuminated2020", avatar_url: "https://avatars.githubusercontent.com/u/53017147", html_url: "https://github.com/Illuminated2020", contributions: 40 },
    { login: "rarnu", avatar_url: "https://avatars.githubusercontent.com/u/28835581", html_url: "https://github.com/rarnu", contributions: 23 },
    { login: "SuLea-IT", avatar_url: "https://avatars.githubusercontent.com/u/105108570", html_url: "https://github.com/SuLea-IT", contributions: 22 },
    { login: "serenez", avatar_url: "https://github.com/serenez.png", html_url: "https://github.com/serenez", contributions: 22 },
    { login: "yavon007", avatar_url: "https://avatars.githubusercontent.com/u/61088461", html_url: "https://github.com/yavon007", contributions: 18 },
    { login: "Bacon2994", avatar_url: "https://avatars.githubusercontent.com/u/108093786", html_url: "https://github.com/Bacon2994", contributions: 11 },
    { login: "Abeautifulsnow", avatar_url: "https://avatars.githubusercontent.com/u/115250255", html_url: "https://github.com/Abeautifulsnow", contributions: 9 },
    { login: "CN-Scars", avatar_url: "https://avatars.githubusercontent.com/u/100192060", html_url: "https://github.com/CN-Scars", contributions: 8 },
    { login: "DengQingNian", avatar_url: "https://avatars.githubusercontent.com/u/117324885", html_url: "https://github.com/DengQingNian", contributions: 7 },
    { login: "xKrah", avatar_url: "https://avatars.githubusercontent.com/u/120772591", html_url: "https://github.com/xKrah", contributions: 7 },
    { login: "agent-43", avatar_url: "https://avatars.githubusercontent.com/u/188405022", html_url: "https://github.com/agent-43", contributions: 6 },
    { login: "eryajf", avatar_url: "https://avatars.githubusercontent.com/u/33259379", html_url: "https://github.com/eryajf", contributions: 5 },
    { login: "wu-clan", avatar_url: "https://avatars.githubusercontent.com/u/114193468", html_url: "https://github.com/wu-clan", contributions: 4 },
    { login: "fraluc06", avatar_url: "https://avatars.githubusercontent.com/u/67560467", html_url: "https://github.com/fraluc06", contributions: 4 },
    { login: "Caisin", avatar_url: "https://avatars.githubusercontent.com/u/62819122", html_url: "https://github.com/Caisin", contributions: 3 },
    { login: "wds824", avatar_url: "https://avatars.githubusercontent.com/u/93659702", html_url: "https://github.com/wds824", contributions: 3 },
  ];
}

export function dedupeContributors(contributors: Contributor[]): Contributor[] {
  const seenLogins = new Set<string>();

  return contributors.filter((contributor) => {
    const normalizedLogin = contributor.login.trim().toLowerCase();
    if (!normalizedLogin || seenLogins.has(normalizedLogin)) return false;
    seenLogins.add(normalizedLogin);
    return true;
  });
}

export async function fetchContributors(): Promise<Contributor[]> {
  const token = process.env.GITHUB_TOKEN;
  const firstPage = `${GITHUB_CONTRIBUTORS_API}?per_page=100`;

  try {
    const allContributors: Contributor[] = [];
    let url: string | null = firstPage;

    while (url) {
      const { data, next } = await fetchPage(url, token);
      allContributors.push(...data);
      url = next;
    }

    if (allContributors.length === 0) return fallbackContributors();

    return dedupeContributors(allContributors.filter((c) => c.login && c.avatar_url && c.type !== "Bot"));
  } catch {
    return fallbackContributors();
  }
}
