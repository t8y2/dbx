import Link from "next/link";
import { contributorAvatarUrl, dedupeContributors, type Contributor } from "@/lib/contributors";

const landingContributorLimit = 72;
const landingContributorRowSizes = [12, 16, 16, 16, 12] as const;

function ContributorAvatar({ c }: { c: Contributor }) {
  return (
    <a
      href={c.html_url}
      target="_blank"
      rel="noopener noreferrer"
      className="landing-contributor-avatar"
      data-stagger
    >
      <img
        src={contributorAvatarUrl(c.avatar_url)}
        alt={c.login}
        width={64}
        height={64}
        loading="lazy"
        decoding="async"
        className="block w-full h-full object-cover"
      />
      <span className="landing-contributor-tooltip">
        <span className="landing-contributor-tooltip-name">{c.login}</span>
        <span className="landing-contributor-tooltip-count">{c.contributions} contributions</span>
      </span>
    </a>
  );
}

export function ContributorsWallContent({ contributors, title, desc, lang }: { contributors: Contributor[]; title: string; desc: string; lang: "en" | "cn" }) {
  const uniqueContributors = dedupeContributors(contributors);
  const visibleContributors = uniqueContributors.slice(0, landingContributorLimit);
  let contributorOffset = 0;
  const contributorRows = landingContributorRowSizes.map((rowSize) => {
    const row = visibleContributors.slice(contributorOffset, contributorOffset + rowSize);
    contributorOffset += rowSize;
    return row;
  });
  if (uniqueContributors.length === 0) return null;

  return (
    <>
      <div className="grid grid-cols-[minmax(220px,0.42fr)_minmax(0,0.58fr)] gap-9 items-end mb-[22px] max-[760px]:block">
        <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{title}</h2>
        <p className="mt-2 max-w-[650px] text-landing-muted text-sm leading-[1.65] justify-self-end text-right max-[760px]:max-w-none max-[760px]:text-left">
          {desc}{" "}
          <Link href={`/${lang}/contributors`} prefetch={false} className="landing-inline-link inline-flex items-center gap-[5px]">
            {lang === "cn" ? `查看 ${uniqueContributors.length}+ 位贡献者` : `Explore ${uniqueContributors.length}+ contributors`}
          </Link>
          <span className="mx-1.5 text-landing-muted" aria-hidden="true">·</span>
          <Link href={`/${lang}/contributors`} prefetch={false} className="landing-inline-link inline-flex items-center gap-[5px]">
            {lang === "cn" ? "下载贡献者证书" : "Download contributor certificate"}
          </Link>
        </p>
      </div>
      <div className="landing-contributor-grid">
        {contributorRows.map((row, rowIndex) => (
          <div className="landing-contributor-row" key={rowIndex}>
            {row.map((c) => (
              <ContributorAvatar key={c.login.toLowerCase()} c={c} />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
