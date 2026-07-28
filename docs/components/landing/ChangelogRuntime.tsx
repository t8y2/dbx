"use client";

import { ChangelogList } from "@/components/landing/ChangelogList";
import type { ChangelogRelease } from "@/lib/changelog";

type ChangelogRuntimeProps = {
  lang: "en" | "cn";
  initialReleases?: ChangelogRelease[];
};

const text = {
  en: {
    empty: "No releases found.",
  },
  cn: {
    empty: "暂无版本记录。",
  },
};

export function ChangelogRuntime({ lang, initialReleases = [] }: ChangelogRuntimeProps) {
  if (initialReleases.length === 0) {
    return <p className="text-landing-muted py-12">{text[lang].empty}</p>;
  }

  return <ChangelogList releases={initialReleases} lang={lang} />;
}
