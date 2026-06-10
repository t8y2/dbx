"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";
import { RevealSection } from "@/components/landing/RevealSection";
import { fetchChangelog, type ChangelogRelease } from "@/lib/changelog";
import { buildLandingLatestUpdates } from "@/lib/landingLatest";
import { fetchLatestReleaseInfo, type LatestReleaseInfo } from "@/lib/latestRelease";

type LandingLatestUpdatesProps = {
  lang: "en" | "cn";
  fallbackVersion: string;
  initialRelease?: ChangelogRelease;
  initialLatestRelease?: LatestReleaseInfo | null;
};

export function LandingLatestUpdates({ lang, fallbackVersion, initialRelease, initialLatestRelease }: LandingLatestUpdatesProps) {
  const [latest, setLatest] = useState(() => buildLandingLatestUpdates(lang, initialRelease, fallbackVersion, initialLatestRelease));

  useEffect(() => {
    let active = true;

    setLatest(buildLandingLatestUpdates(lang, initialRelease, fallbackVersion, initialLatestRelease));
    Promise.all([fetchLatestReleaseInfo(), fetchChangelog(lang)]).then(([releaseInfo, data]) => {
      if (!active) return;

      setLatest(buildLandingLatestUpdates(lang, data.releases[0] ?? initialRelease, fallbackVersion, releaseInfo ?? initialLatestRelease));
    });

    return () => {
      active = false;
    };
  }, [lang, fallbackVersion, initialRelease, initialLatestRelease]);

  return (
    <RevealSection className="grid grid-cols-[minmax(86px,0.16fr)_minmax(210px,0.32fr)_minmax(0,0.38fr)_max-content] gap-[22px] items-center max-w-[1180px] mx-auto px-7 border-t border-b border-landing-line mt-[62px] py-6 max-[1040px]:grid-cols-[minmax(0,1fr)_max-content] max-[760px]:block max-[760px]:px-[18px]">
      <div className="landing-update-version w-max rounded-[7px] px-2.5 py-[7px] text-[13px] font-[720]">{latest.version}</div>
      <div className="max-[1040px]:col-span-full max-[760px]:mt-4">
        <h2 className="m-0 text-[21px] font-[720] text-landing-ink">{latest.title}</h2>
        <p className="mt-1.5 text-landing-muted text-[13px] leading-[1.55]">{latest.desc}</p>
      </div>
      <ul className="grid gap-2 m-0 p-0 list-none max-[1040px]:col-span-full max-[760px]:mt-4">
        {latest.items.map((item) => (
          <li key={item} className="flex gap-2 items-center text-[13px] font-[560] leading-[1.45] text-[color-mix(in_srgb,var(--color-landing-ink)_88%,var(--color-landing-muted))]" data-stagger>
            <CheckCircle2 size={14} className="shrink-0 text-landing-green" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
      <Link href={`/${lang}/changelog`} className="landing-inline-link flex shrink-0 items-center gap-[7px] text-sm font-[650] max-[760px]:mt-4">
        {latest.link}
        <ArrowRight size={15} />
      </Link>
    </RevealSection>
  );
}
