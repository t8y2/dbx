"use client";

import { useState } from "react";
import Link from "next/link";
import type { Contributor } from "@/lib/contributors";

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

export function ContributorsWallContent({ contributors, title, desc }: { contributors: Contributor[]; title: string; desc: string }) {
  if (contributors.length === 0) return null;

  return (
    <>
      <div className="grid grid-cols-[minmax(220px,0.42fr)_minmax(0,0.58fr)] gap-9 items-end mb-[22px] max-[760px]:block">
        <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{title}</h2>
        <p className="mt-2 max-w-[650px] text-landing-muted text-sm leading-[1.65] justify-self-end text-right max-[760px]:max-w-none max-[760px]:text-left">
          {desc}{" "}
          <Link href="https://github.com/t8y2/dbx/graphs/contributors" target="_blank" className="landing-inline-link inline-flex items-center gap-[5px]">
            {contributors.length}+ contributors on GitHub
          </Link>
        </p>
      </div>
      <div className="landing-contributor-grid">
        {contributors.map((c) => (
          <ContributorAvatar key={c.login} c={c} />
        ))}
      </div>
    </>
  );
}
