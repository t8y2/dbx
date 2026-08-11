"use client";

import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import type { ChangelogRelease } from "@/lib/changelog";
import { ChevronDown, Tag } from "lucide-react";

const PAGE_SIZE = 5;

const DESKTOP_MEDIA = "(min-width: 761px)";

function subscribeToDesktop(onChange: () => void) {
  const mql = window.matchMedia(DESKTOP_MEDIA);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getDesktopSnapshot() {
  return window.matchMedia(DESKTOP_MEDIA).matches;
}

function getDesktopServerSnapshot() {
  return false;
}

const sectionLabels: Record<string, Record<string, string>> = {
  added: { en: "New Features", cn: "新功能" },
  improved: { en: "Improvements", cn: "改进" },
  fixed: { en: "Bug Fixes", cn: "问题修复" },
  changed: { en: "Changes", cn: "变更" },
  removed: { en: "Removed", cn: "移除" },
};

function formatDate(dateStr: string, lang: string) {
  const d = new Date(dateStr);
  if (lang === "cn") {
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function ReleaseCard({ release, lang, featured, expanded }: { release: ChangelogRelease; lang: string; featured: boolean; expanded: boolean }) {
  const t = lang === "cn" ? { publishedOn: "发布于", download: "下载", seeGitHub: "查看 GitHub Release 获取详情" } : { publishedOn: "Published on", download: "Download", seeGitHub: "See GitHub Release for details" };

  return (
    <details className="changelog-release border-t border-[rgba(155,176,205,0.18)]" open={featured || expanded || undefined}>
      <summary className="changelog-release-summary min-h-[72px] cursor-pointer list-none items-center justify-between gap-4 py-4 text-[#e2e8f0]">
        <span className="min-w-0">
          <strong className="block truncate text-[17px] font-[720]">Release {release.tag}</strong>
          <span className="mt-1 block text-xs text-[#64748b]">{formatDate(release.date, lang)}</span>
        </span>
        <ChevronDown className="changelog-release-chevron shrink-0 text-[#6ea8ff]" size={18} />
      </summary>
      <div className="changelog-release-body py-12 max-[760px]:py-8">
        <div className="flex items-center justify-between gap-4 mb-8 max-[760px]:items-start max-[760px]:flex-wrap max-[760px]:mb-6">
          <div className="flex items-center gap-4 max-[760px]:flex-wrap max-[760px]:gap-2.5">
            <span className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-[rgba(155,176,205,0.25)] text-sm font-semibold text-[#e2e8f0]">
              <Tag size={13} className="text-[#6ea8ff]" />
              {release.tag.replace("v", "")}
            </span>
            <span className="text-[15px] text-[#64748b] max-[760px]:text-[13px]">
              {t.publishedOn} {formatDate(release.date, lang)}
            </span>
          </div>
          <a href={`https://github.com/t8y2/dbx/releases/tag/${release.tag}`} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-1.5 px-4 rounded-full border border-[rgba(155,176,205,0.25)] text-sm text-[#e2e8f0] hover:border-[rgba(155,176,205,0.4)] transition-colors">
            {t.download}
            <ChevronDown size={14} />
          </a>
        </div>

        <h2 className="text-[28px] font-[720] text-[#f7fbff] mb-10 max-[760px]:text-2xl max-[760px]:mb-7">Release {release.tag}</h2>

        {release.sections.map((section, sectionIndex) => (
          <div key={sectionIndex} className={sectionIndex > 0 ? "mt-10 max-[760px]:mt-8" : ""}>
            <h3 className="text-xl font-bold text-[#f7fbff] mb-5 max-[760px]:text-lg max-[760px]:mb-4">{sectionLabels[section.type]?.[lang] || section.title}</h3>
            <ul className="space-y-3">
              {section.items.map((item, itemIndex) => (
                <li key={itemIndex} className="flex gap-3 text-[15px] leading-relaxed text-[#b8c5d6] max-[760px]:text-sm">
                  <span className="mt-2 w-1.5 h-1.5 rounded-full bg-[#475569] shrink-0" />
                  <span>
                    {item.desc ? (
                      <>
                        {item.title}，{item.desc}
                      </>
                    ) : (
                      item.title
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}

        {release.sections.length === 0 && <p className="text-[15px] text-[#64748b] italic">{t.seeGitHub}</p>}
      </div>
    </details>
  );
}

export function ChangelogList({ releases, lang }: { releases: ChangelogRelease[]; lang: string }) {
  const [count, setCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const isDesktop = useSyncExternalStore(subscribeToDesktop, getDesktopSnapshot, getDesktopServerSnapshot);
  const visible = releases.slice(0, count);
  const hasMore = count < releases.length;

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setCount((c) => Math.min(c + PAGE_SIZE, releases.length));
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [count, hasMore, releases.length]);

  return (
    <>
      {visible.map((release, index) => (
        <ReleaseCard key={release.tag} release={release} lang={lang} featured={index === 0} expanded={isDesktop} />
      ))}
      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-12 text-[#64748b] text-sm">
          {lang === "cn" ? "加载更多版本…" : "Loading more versions…"}
        </div>
      )}
    </>
  );
}
