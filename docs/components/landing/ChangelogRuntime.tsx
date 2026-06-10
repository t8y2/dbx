"use client";

import { useEffect, useState } from "react";
import { ChangelogList } from "@/components/landing/ChangelogList";
import { fetchChangelog, type ChangelogRelease } from "@/lib/changelog";

type ChangelogRuntimeProps = {
  lang: "en" | "cn";
  initialReleases?: ChangelogRelease[];
};

const text = {
  en: {
    loading: "Loading releases...",
    empty: "No releases found.",
  },
  cn: {
    loading: "正在加载版本记录...",
    empty: "暂无版本记录。",
  },
};

export function ChangelogRuntime({ lang, initialReleases = [] }: ChangelogRuntimeProps) {
  const [releases, setReleases] = useState<ChangelogRelease[] | null>(initialReleases);

  useEffect(() => {
    let active = true;

    fetchChangelog(lang).then((data) => {
      if (active && data.releases.length > 0) {
        setReleases(data.releases);
      }
    });

    return () => {
      active = false;
    };
  }, [lang]);

  if (releases === null) {
    return <p className="text-landing-muted py-12">{text[lang].loading}</p>;
  }

  if (releases.length === 0) {
    return <p className="text-landing-muted py-12">{text[lang].empty}</p>;
  }

  return <ChangelogList releases={releases} lang={lang} />;
}
