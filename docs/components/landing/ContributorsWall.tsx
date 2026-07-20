"use client";

import { useState } from "react";
import Link from "next/link";
import { dedupeContributors, type Contributor } from "@/lib/contributors";

function ContributorAvatar({ c }: { c: Contributor }) {
  const [hovered, setHovered] = useState(false);

  return (
    <a
      href={c.html_url}
      target="_blank"
      rel="noopener noreferrer"
      className="landing-contributor-avatar"
      data-stagger
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <img
        src={c.avatar_url}
        alt={c.login}
        width={64}
        height={64}
        loading="lazy"
        className="block w-full h-full object-cover"
      />
      <span className={`landing-contributor-tooltip${hovered ? " is-visible" : ""}`}>
        <span className="landing-contributor-tooltip-name">{c.login}</span>
        <span className="landing-contributor-tooltip-count">{c.contributions} contributions</span>
      </span>
    </a>
  );
}

export function ContributorsWallContent({ contributors, title, desc, lang }: { contributors: Contributor[]; title: string; desc: string; lang: "en" | "cn" }) {
  const uniqueContributors = dedupeContributors(contributors);
  if (uniqueContributors.length === 0) return null;

  return (
    <>
      <div className="grid grid-cols-[minmax(220px,0.42fr)_minmax(0,0.58fr)] gap-9 items-end mb-[22px] max-[760px]:block">
        <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{title}</h2>
        <p className="mt-2 max-w-[650px] text-landing-muted text-sm leading-[1.65] justify-self-end text-right max-[760px]:max-w-none max-[760px]:text-left">
          {desc}{" "}
          <Link href={`/${lang}/contributors`} className="landing-inline-link inline-flex items-center gap-[5px]">
            {lang === "cn" ? `查看 ${uniqueContributors.length}+ 位贡献者` : `Explore ${uniqueContributors.length}+ contributors`}
          </Link>
          <span className="mx-1.5 text-landing-muted" aria-hidden="true">·</span>
          <Link href={`/${lang}/contributors`} className="landing-inline-link inline-flex items-center gap-[5px]">
            {lang === "cn" ? "下载贡献者证书" : "Download contributor certificate"}
          </Link>
        </p>
      </div>
      <div className="landing-contributor-grid">
        {uniqueContributors.map((c) => (
          <ContributorAvatar key={c.login.toLowerCase()} c={c} />
        ))}
      </div>
    </>
  );
}
