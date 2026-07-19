export type ContributorActivity = {
  login: string;
  avatarUrl: string;
  profileUrl: string;
  commits: number;
  mergedPullRequests: number;
  firstContributionAt: string | null;
  latestContributionAt: string | null;
};

export type ContributorActivityData = {
  repository: string;
  generatedAt: string;
  stars: number;
  contributors: ContributorActivity[];
};

export function sortContributorActivity(contributors: ContributorActivity[]): ContributorActivity[] {
  return [...contributors].sort((left, right) => {
    const commitDifference = right.commits - left.commits;
    if (commitDifference !== 0) return commitDifference;

    const pullRequestDifference = right.mergedPullRequests - left.mergedPullRequests;
    if (pullRequestDifference !== 0) return pullRequestDifference;

    return left.login.localeCompare(right.login, "en", { sensitivity: "base" });
  });
}
