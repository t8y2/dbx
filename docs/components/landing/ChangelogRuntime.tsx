"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChangelogList } from "@/components/landing/ChangelogList";
import { changelogReleaseUrl, type ChangelogIndexEntry, type ChangelogRelease } from "@/lib/changelog";
import { requestJson } from "@/lib/httpJson";

type ChangelogRuntimeProps = {
  lang: "en" | "cn";
  index: ChangelogIndexEntry[];
  initialRelease: ChangelogRelease | null;
  fallbackReleases?: ChangelogRelease[] | null;
};

const text = {
  en: {
    empty: "No releases found.",
    loadError: "Failed to load this release. Please retry or check GitHub Releases.",
  },
  cn: {
    empty: "暂无版本记录。",
    loadError: "该版本加载失败，请稍后重试或前往 GitHub Releases 查看。",
  },
};

export function ChangelogRuntime({ lang, index, initialRelease, fallbackReleases = null }: ChangelogRuntimeProps) {
  const [selectedTag, setSelectedTag] = useState(initialRelease?.tag ?? index[0]?.tag ?? "");
  const [release, setRelease] = useState<ChangelogRelease | null>(initialRelease);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  // tag -> 已加载的版本详情；SSR 注入的首个版本与全量兜底数据都放进同一缓存。
  const releaseCacheRef = useRef<Map<string, ChangelogRelease>>(new Map());
  const cache = releaseCacheRef.current;

  if (initialRelease && !cache.has(initialRelease.tag)) {
    cache.set(initialRelease.tag, initialRelease);
  }
  for (const fallback of fallbackReleases ?? []) {
    if (!cache.has(fallback.tag)) cache.set(fallback.tag, fallback);
  }

  useEffect(() => {
    if (!selectedTag) return;

    const cached = cache.get(selectedTag);
    if (cached) {
      setRelease(cached);
      setErrorMessage(undefined);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setErrorMessage(undefined);
    setRelease(null);

    requestJson<ChangelogRelease>(changelogReleaseUrl(lang, selectedTag))
      .then((data) => {
        if (cancelled) return;
        cache.set(selectedTag, data);
        setRelease(data);
      })
      .catch(() => {
        if (cancelled) return;
        setErrorMessage(text[lang].loadError);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedTag, lang, cache]);

  if (index.length === 0) {
    return <p className="text-landing-muted py-12">{text[lang].empty}</p>;
  }

  // 切换版本后把视口拉回该版本内容顶部；否则会停留在上一个版本的滚动位置，
  // 右侧目录锚点看起来就像没有对上。
  const selectRelease = useCallback(
    (tag: string) => {
      setSelectedTag(tag);
      if (typeof document === "undefined") return;
      const content = document.querySelector(".changelog-content");
      if (!content) return;
      const top = content.getBoundingClientRect().top + window.scrollY - 96;
      if (Math.abs(top - window.scrollY) > 8) {
        window.scrollTo({ top: Math.max(top, 0), behavior: "smooth" });
      }
    },
    [],
  );

  return (
    <ChangelogList
      releaseIndex={index}
      selectedTag={selectedTag}
      release={release}
      lang={lang}
      isLoading={isLoading}
      errorMessage={errorMessage}
      onSelectRelease={selectRelease}
    />
  );
}
