#!/usr/bin/env node

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "t8y2/dbx";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const OUT_CN = "releases-cn.json";
const OUT_EN = "releases-en.json";
const LATEST_EN_OUT = "latest-en.json";
const EN_CACHE_URL = process.env.CHANGELOG_EN_CACHE_URL || "https://dl.dbxio.com/changelog/releases-en.json";

const SECTION_MAP = {
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

export async function fetchAllReleases() {
  const releases = [];
  let page = 1;
  while (true) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.length === 0) break;
    releases.push(...data);
    page++;
  }
  return releases;
}

export function stripDownloadSection(body) {
  const markers = ["### 下载安装", "### Download", "### 系统要求", "### System Requirements"];
  let idx = body.length;
  for (const m of markers) {
    const i = body.indexOf(m);
    if (i !== -1 && i < idx) idx = i;
  }
  return body.slice(0, idx).trim();
}

// 剥离 release notes 里的 issue 引用 (closes #xxx)，保留贡献者署名 (contributed by @xxx)。
// 同时处理纯 closes 括号和混在 contributed by 括号里的 closes 片段。
function stripIssueRefs(text) {
  return text
    // 纯 closes 括号整体去掉，如 (closes #123) 或 (closes #123, closes #456)
    .replace(/\s*\(closes #\d+(?:,\s*closes #\d+)*\)/g, "")
    // closes 在前、contributed by 在后，如 (closes #88, contributed by @xxx) → (contributed by @xxx)
    .replace(/\(closes #\d+,\s*/g, "(")
    // contributed by 在前、closes 在后，如 (contributed by @xxx, closes #123) → (contributed by @xxx)
    .replace(/,\s*closes #\d+/g, "");
}

// 对整份 releases JSON 统一剥离 closes # 引用。cache 复用的英文翻译来自 R2，
// 可能是旧版脚本生成的（desc 仍含 closes #），在写文件前统一清理一次。
function stripIssueRefsInReleases(json) {
  for (const release of json.releases || []) {
    for (const section of release.sections || []) {
      for (const item of section.items || []) {
        if (item.desc) item.desc = stripIssueRefs(item.desc);
      }
    }
  }
  return json;
}

export function parseBody(body) {
  const cleaned = stripDownloadSection(body);
  const sections = [];
  let current = null;

  for (const line of cleaned.split("\n")) {
    const headerMatch = line.match(/^###\s+(.+)/);
    if (headerMatch) {
      const title = headerMatch[1].trim();
      const type = SECTION_MAP[title] || "other";
      current = { type, title, items: [] };
      sections.push(current);
      continue;
    }

    if (!current) continue;

    const itemMatch = line.match(/^-\s+\*\*(.+?)\*\*\s*[—–-]\s*(.+)/);
    if (itemMatch) {
      current.items.push({ title: itemMatch[1].trim(), desc: stripIssueRefs(itemMatch[2].trim()) });
      continue;
    }

    const plainMatch = line.match(/^-\s+(.+)/);
    if (plainMatch) {
      current.items.push({ title: plainMatch[1].trim(), desc: "" });
    }
  }

  return sections.filter((s) => s.items.length > 0);
}

export function buildReleaseSourceHash(release) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        tag: release.tag_name,
        name: release.name || release.tag_name,
        publishedAt: release.published_at || "",
        body: release.body || "",
      }),
    )
    .digest("hex");
}

export function buildReleasesJson(releases, now = new Date()) {
  return {
    updatedAt: now.toISOString(),
    releases: releases
      .filter((r) => !r.draft && !r.prerelease && !r.tag_name.startsWith("agents-"))
      .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
      .map((r) => ({
        tag: r.tag_name,
        name: r.name || r.tag_name,
        date: r.published_at.slice(0, 10),
        _sourceHash: buildReleaseSourceHash(r),
        sections: parseBody(r.body || ""),
      })),
  };
}

function releaseToMarkdown(release) {
  return release.sections
    .map((s) => {
      const items = s.items.map((i) => (i.desc ? `- **${i.title}** — ${i.desc}` : `- ${i.title}`)).join("\n");
      return `### ${s.title}\n${items}`;
    })
    .join("\n\n");
}

// 给应用内更新提示用的英文 notes：只取最新一条版本（releases 已按 published_at 降序），
// 转成 md。version 用 tag（如 v0.5.47），应用端 normalize_version 后与 latest.json 的 version 校验。
function buildLatestEnNotes(enReleasesJson) {
  const latest = enReleasesJson.releases?.[0];
  if (!latest) return null;
  return {
    version: latest.tag,
    notes: releaseToMarkdown(latest),
  };
}

export async function fetchCachedEnglish({ cacheUrl = EN_CACHE_URL, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(cacheUrl, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.warn(`English changelog cache unavailable: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`English changelog cache unavailable: ${err.message}`);
    return null;
  }
}

export async function translateToEnglish(cnJson, { cachedEnJson = null, deepseekApiKey = DEEPSEEK_API_KEY, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const cachedByTag = new Map((cachedEnJson?.releases || []).map((release) => [release.tag, release]));
  const enReleases = [];
  let reusedCount = 0;
  let translatedCount = 0;
  let skippedCount = 0;

  // 无 API key：仅复用 R2 上的英文缓存，未命中的条目回退中文以保证文件完整。
  // 这样本地（无 key）只要 R2 缓存新鲜也能产出英文 CHANGELOG；CI 有 key 时走正常翻译流程。
  if (!deepseekApiKey) {
    console.warn("DEEPSEEK_API_KEY not set, falling back to cached English translations only");
    for (const release of cnJson.releases) {
      const cachedRelease = cachedByTag.get(release.tag);
      if (cachedRelease?._sourceHash === release._sourceHash) {
        enReleases.push({ ...cachedRelease, name: release.name, date: release.date, _sourceHash: release._sourceHash });
        reusedCount++;
      } else {
        enReleases.push(release);
        skippedCount++;
      }
    }
    console.log(`English changelog cache reused ${reusedCount}, skipped ${skippedCount} (no API key)`);
    return { updatedAt: cnJson.updatedAt, releases: enReleases };
  }

  for (const release of cnJson.releases) {
    const cachedRelease = cachedByTag.get(release.tag);
    if (cachedRelease?._sourceHash === release._sourceHash) {
      enReleases.push({
        ...cachedRelease,
        name: release.name,
        date: release.date,
        _sourceHash: release._sourceHash,
      });
      reusedCount++;
      continue;
    }

    const sectionsText = releaseToMarkdown(release);

    if (!sectionsText.trim()) {
      enReleases.push({ ...release, sections: [] });
      continue;
    }

    const res = await fetchImpl("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${deepseekApiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content:
              "You are a technical translator. Translate the following Chinese software changelog to English. Keep the exact markdown format (### headers, - bullet points, **bold** titles, — dashes). Only translate, do not add or remove content. Keep technical terms, product names, and contributor names unchanged.",
          },
          { role: "user", content: sectionsText },
        ],
        temperature: 0.1,
      }),
    });

    if (!res.ok) {
      console.error(`DeepSeek API error for ${release.tag}: ${res.status}`);
      enReleases.push(release);
      continue;
    }

    const data = await res.json();
    const translated = data.choices?.[0]?.message?.content || "";
    const enSections = parseBody(translated);
    enReleases.push({ ...release, sections: enSections.length > 0 ? enSections : release.sections });
    translatedCount++;

    await sleep(200);
  }

  console.log(`English changelog cache reused ${reusedCount} release(s), translated ${translatedCount} release(s)`);
  return { updatedAt: cnJson.updatedAt, releases: enReleases };
}

async function main() {
  console.log("Fetching releases from GitHub...");
  const releases = await fetchAllReleases();
  console.log(`Found ${releases.length} releases`);

  const cnJson = buildReleasesJson(releases);
  console.log(`Processed ${cnJson.releases.length} non-draft releases`);

  writeFileSync(OUT_CN, JSON.stringify(cnJson, null, 2));
  console.log(`Wrote ${OUT_CN}`);

  console.log("Fetching cached English changelog...");
  const cachedEnJson = await fetchCachedEnglish();

  console.log("Translating to English...");
  const enJson = await translateToEnglish(cnJson, { cachedEnJson });
  if (enJson) {
    // cache 复用的英文翻译可能来自旧版 R2 数据（desc 含 closes # 引用），统一剥离一次
    stripIssueRefsInReleases(enJson);
    writeFileSync(OUT_EN, JSON.stringify(enJson, null, 2));
    console.log(`Wrote ${OUT_EN}`);

    // 应用内更新提示用的英文 notes（单条最新版本）
    const latestEn = buildLatestEnNotes(enJson);
    if (latestEn) {
      writeFileSync(LATEST_EN_OUT, JSON.stringify(latestEn, null, 2));
      console.log(`Wrote ${LATEST_EN_OUT}`);
    }
  }

  console.log("Done!");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
