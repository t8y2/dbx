import type { ContributorActivity } from "@/lib/contributorActivity";

export type Contributor = {
  login: string;
  avatar_url: string;
  html_url: string;
  contributions: number;
  type?: string;
};

export function dedupeContributors(contributors: Contributor[]): Contributor[] {
  const seenLogins = new Set<string>();

  return contributors.filter((contributor) => {
    const normalizedLogin = contributor.login.trim().toLowerCase();
    if (!normalizedLogin || seenLogins.has(normalizedLogin)) return false;
    seenLogins.add(normalizedLogin);
    return true;
  });
}

export function contributorsFromActivity(contributors: readonly ContributorActivity[]): Contributor[] {
  return dedupeContributors(
    contributors.map((contributor) => ({
      login: contributor.login,
      avatar_url: contributor.avatarUrl,
      html_url: contributor.profileUrl,
      contributions: contributor.commits,
    })),
  );
}
