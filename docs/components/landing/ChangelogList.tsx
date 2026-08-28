"use client";

import { marked, Renderer } from "marked";
import type { ChangelogIndexEntry, ChangelogRelease } from "@/lib/changelog";
import { Tag } from "lucide-react";

const sectionLabels: Record<string, Record<string, string>> = {
  added: { en: "New Features", cn: "新功能" },
  improved: { en: "Improvements", cn: "改进" },
  fixed: { en: "Bug Fixes", cn: "问题修复" },
  changed: { en: "Changes", cn: "变更" },
  removed: { en: "Removed", cn: "移除" },
};

// 与 .github/scripts/sync-changelog.mjs 的 SECTION_MAP 保持一致，
// TOC 文案优先用本地化标签，未知标题原样展示。
const sectionTypeByTitle: Record<string, string> = {
  新功能: "added",
  Added: "added",
  改进: "improved",
  Improved: "improved",
  修复: "fixed",
  Fixed: "fixed",
  变更: "changed",
  Changed: "changed",
  移除: "removed",
  Removed: "removed",
};

function formatDate(dateStr: string, lang: string) {
  const date = new Date(dateStr);
  if (lang === "cn") {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function releaseId(tag: string) {
  return `changelog-release-${tag.replace(/[^a-zA-Z0-9-]/g, "-")}`;
}

function sectionId(tag: string, sectionIndex: number) {
  return `${releaseId(tag)}-section-${sectionIndex}`;
}

function releaseToMarkdown(release: ChangelogRelease) {
  return release.sections
    .map((section) => {
      const items = section.items.map((item) => (item.desc ? `- **${item.title}** — ${item.desc}` : `- ${item.title}`)).join("\n");
      return `### ${section.title}\n${items}`;
    })
    .join("\n\n");
}

// 官网展示用：剥掉条目行尾的贡献/来源标注括号段，让页面更纯净，
// 如 “(contributed by @user) (PR [#123](…)) (commit [sha](…)) (closes #456)”。
// 括号段内可能嵌套 markdown 链接，需按配对括号从行尾向前定位段首；
// 普通内容括号（如 “(默认关闭)”）不含这些特征词，不会被误伤。
const ATTRIBUTION_HINT = /contributed by|\b(?:PR|closes|refs|fixes)\b|^commit\b|@[\w.-]+|^#\d/i;

function stripTrailingAttribution(line: string) {
  let out = line.trimEnd();
  for (;;) {
    if (!out.endsWith(")")) break;
    let depth = 0;
    let start = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i] === ")") depth++;
      else if (out[i] === "(" && --depth === 0) {
        start = i;
        break;
      }
    }
    if (start < 1 || !ATTRIBUTION_HINT.test(out.slice(start + 1, -1))) break;
    out = out.slice(0, start).trimEnd();
  }
  // 整条 desc 都是标注时避免留下悬空的破折号；横线分隔线不受影响
  return out.replace(/[ \t]*[—–]$/, "");
}

function releaseDisplayMarkdown(release: ChangelogRelease) {
  return (release.markdown || releaseToMarkdown(release))
    .split("\n")
    .map(stripTrailingAttribution)
    .join("\n");
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderMarkdown(release: ChangelogRelease) {
  const renderer = new Renderer();
  let headingIndex = 0;

  renderer.heading = ({ tokens, depth }) => {
    const text = renderer.parser.parseInline(tokens);
    const id = depth === 3 ? ` id="${sectionId(release.tag, headingIndex++)}"` : "";
    return `<h${depth}${id}>${text}</h${depth}>`;
  };
  renderer.html = ({ text }) => escapeHtml(text);

  return marked.parse(releaseDisplayMarkdown(release), { gfm: true, renderer }) as string;
}

// TOC 必须与 renderMarkdown 数的是同一批 h3（跳过代码围栏里的 "### "），
// 否则 parseBody 过滤掉无条目小节后，锚点序号会整体错位。
function buildTocEntries(release: ChangelogRelease, lang: string) {
  const markdown = releaseDisplayMarkdown(release);
  const titles: string[] = [];
  let inFence = false;

  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const headingMatch = line.match(/^###\s+(.+)/);
    if (headingMatch) titles.push(headingMatch[1].trim());
  }

  return titles.map((title, index) => ({
    id: sectionId(release.tag, index),
    label: sectionLabels[sectionTypeByTitle[title] ?? ""]?.[lang] || title,
  }));
}

function ReleaseCard({ release, lang, isLoading, errorMessage }: { release: ChangelogRelease | null; lang: "en" | "cn"; isLoading: boolean; errorMessage?: string }) {
  const text = lang === "cn" ? { publishedOn: "发布于", download: "下载", seeGitHub: "查看 GitHub Release 获取详情" } : { publishedOn: "Published on", download: "Download", seeGitHub: "See GitHub Release for details" };

  if (!release) {
    return (
      <section className="changelog-release changelog-release-loading" aria-busy="true">
        <div className="changelog-loading-inner">
          <span>{errorMessage || (isLoading ? (lang === "cn" ? "正在加载版本…" : "Loading release…") : text.seeGitHub)}</span>
        </div>
      </section>
    );
  }

  return (
    // 用 section 而非 article：docs 的 article 排版规则是浅色主题，
    // 会把这里的链接/行内代码染黑。
    <section id={releaseId(release.tag)} className="changelog-release">
      <div className="changelog-release-body py-12 max-[760px]:py-8">
        <div className="flex items-center justify-between gap-4 mb-8 max-[760px]:items-start max-[760px]:flex-wrap max-[760px]:mb-6">
          <div className="flex items-center gap-4 max-[760px]:flex-wrap max-[760px]:gap-2.5">
            <span className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-[rgba(173,176,182,0.25)] text-sm font-semibold text-[#e4e7ea]">
              <Tag size={13} className="text-[#6ea8ff]" />
              {release.tag.replace(/^v/, "")}
            </span>
            <span className="text-[15px] text-[#71717a] max-[760px]:text-[13px]">
              {text.publishedOn} {formatDate(release.date, lang)}
            </span>
          </div>
          <a href={`https://github.com/t8y2/dbx/releases/tag/${release.tag}`} target="_blank" rel="noopener noreferrer" className="flex min-h-9 items-center px-4 rounded-full border border-[rgba(173,176,182,0.25)] text-sm text-[#e4e7ea] hover:border-[rgba(173,176,182,0.4)] transition-colors">
            {text.download}
          </a>
        </div>

        <div className="changelog-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(release) }} />
      </div>
    </section>
  );
}

export function ChangelogList({ releaseIndex, selectedTag, release, lang, isLoading, errorMessage, onSelectRelease }: { releaseIndex: ChangelogIndexEntry[]; selectedTag: string; release: ChangelogRelease | null; lang: "en" | "cn"; isLoading: boolean; errorMessage?: string; onSelectRelease: (tag: string) => void }) {
  const activeTag = release?.tag || selectedTag || releaseIndex[0]?.tag;
  const tocEntries = release ? buildTocEntries(release, lang) : [];

  return (
    <div className="changelog-shell">
      <aside className="changelog-sidebar changelog-sidebar-left" aria-label={lang === "cn" ? "版本列表" : "Release list"}>
        <div className="changelog-sidebar-inner">
          <div className="changelog-sidebar-title">
            <Tag size={18} strokeWidth={1.8} />
            <span>{lang === "cn" ? "版本列表" : "Versions"}</span>
          </div>
          <nav className="changelog-version-list">
            {releaseIndex.map((entry) => (
              <button key={entry.tag} type="button" className={`changelog-version-link${entry.tag === selectedTag ? " is-active" : ""}`} onClick={() => onSelectRelease(entry.tag)} aria-current={entry.tag === selectedTag ? "page" : undefined}>
                <span>{entry.tag}</span>
              </button>
            ))}
          </nav>
        </div>
      </aside>

      <section className="changelog-content" aria-label={lang === "cn" ? "更新日志内容" : "Changelog content"}>
        <ReleaseCard release={release} lang={lang} isLoading={isLoading} errorMessage={errorMessage} />
      </section>

      {release && tocEntries.length > 0 && (
        <aside className="changelog-sidebar changelog-sidebar-right" aria-label={lang === "cn" ? "当前版本目录" : "Current release contents"}>
          <div className="changelog-sidebar-inner">
            <p className="changelog-toc-title">{lang === "cn" ? `在 ${activeTag} 中` : `In ${activeTag}`}</p>
            <p className="changelog-toc-subtitle">{lang === "cn" ? "更新内容" : "Release contents"}</p>
            <nav className="changelog-toc-list">
              {tocEntries.map((entry) => (
                <a key={entry.id} href={`#${entry.id}`}>
                  {entry.label}
                </a>
              ))}
            </nav>
          </div>
        </aside>
      )}
    </div>
  );
}
