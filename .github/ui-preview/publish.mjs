// The trusted half of the UI preview: never runs the PR's code.
//
//   node publish.mjs detect   — does the PR touch the UI? (GITHUB_OUTPUT: ui,
//                               lane, sha, number) and, when it does, puts
//                               the "recording" note in the PR's description
//   node publish.mjs publish  — the recording (OUT_DIR, from record.mjs) onto
//                               the ui-previews branch, served by Pages, and
//                               the preview into the PR's description
//
// The preview lives in one fixed block at the foot of the description,
// between the markers below; each run replaces that block and leaves the
// rest of the description as the author wrote it.
//
// lane: "rust" when the diff reaches the backend (crates/, plugins/,
// src-tauri/) — then CI builds dbx-web from the PR; anything else builds
// only the frontend and runs it against the released dbx-web.
//
// env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR, OUT_DIR, RECORD_RESULT, RUN_URL
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BEGIN = "<!-- dbx-ui-preview:begin -->";
const END = "<!-- dbx-ui-preview:end -->";
const BRANCH = "ui-previews";
const repo = process.env.GITHUB_REPOSITORY;
const pr = Number(process.env.PR);
const token = process.env.GITHUB_TOKEN;
const runURL = process.env.RUN_URL || "";
// what counts as the UI: the app's own sources, not their tests
const NOT_TEST = (f) => !/(__tests__|\.spec\.|\.test\.|\.bench\.)/.test(f);
const UI = (f) => /^apps\/desktop\/src\//.test(f) && NOT_TEST(f);
const RUST = (f) => /^(crates|plugins|src-tauri)\//.test(f);

async function gh(p, init = {}) {
  const res = await fetch(`https://api.github.com${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${p}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

async function files() {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await gh(`/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
    out.push(...batch.map((f) => f.filename));
    if (batch.length < 100) break;
  }
  return out;
}

// the description with the block in place of the old one, or at its foot
function withBlock(body, block) {
  body = body || "";
  const a = body.indexOf(BEGIN), b = body.indexOf(END);
  if (a >= 0 && b > a) return body.slice(0, a) + block + body.slice(b + END.length);
  return body.replace(/\s*$/, "") + "\n\n" + block;
}
async function setBlock(inner) {
  // read just before writing, so an edit the author just made is kept
  const cur = await gh(`/repos/${repo}/pulls/${pr}`);
  const next = withBlock(cur.body, `${BEGIN}\n${inner.trim()}\n${END}`);
  if (next !== cur.body) await gh(`/repos/${repo}/pulls/${pr}`, { method: "PATCH", body: JSON.stringify({ body: next }) });
}

const short = (sha) => sha.slice(0, 7);
const head = (sha) => `---\n### 🎬 界面预览\n<sub>CI 用这个 PR 的前端构建并真实运行 dbx（沙盒环境，dbx-web 后端 + 本地 SQLite 种子数据），按改动自动操作、截图和录屏 · <code>${short(sha)}</code>${runURL ? ` · [运行记录](${runURL})` : ""}</sub>\n`;

async function detect() {
  const p = await gh(`/repos/${repo}/pulls/${pr}`);
  const changed = await files();
  const forced = p.labels.some((l) => l.name === "ui-preview");
  const ui = forced || changed.some(UI);
  const lane = changed.some(RUST) ? "rust" : "web";
  const out = process.env.GITHUB_OUTPUT;
  const lines = [`ui=${ui}`, `lane=${lane}`, `sha=${p.head.sha}`, `number=${pr}`];
  if (out) await fs.appendFile(out, lines.join("\n") + "\n");
  console.log(lines.join(" "), "·", changed.filter(UI).join(", ") || "no UI files");
  if (ui && p.state === "open") await setBlock(`${head(p.head.sha)}\n⏳ 正在录制这次提交的界面改动…`);
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// the recording onto the ui-previews branch: one commit, replaced each time
// so the branch never piles up old videos; another PR's run pushing in
// between makes this one start over from theirs
async function pushMedia(sha, dir) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "ui-previews-"));
  const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
  git(["init", "-q"], work);
  git(["config", "user.name", "github-actions[bot]"], work);
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], work);
  const open = new Set((await gh(`/repos/${repo}/pulls?state=open&per_page=100`)).map((p) => p.number));
  for (let attempt = 0; attempt < 6; attempt++) {
    let base = "";
    try {
      git(["fetch", "-q", "--depth=1", remote, BRANCH], work);
      base = git(["rev-parse", "FETCH_HEAD"], work);
      git(["checkout", "-q", "-f", "--detach", "FETCH_HEAD"], work);
    } catch { /* the first one */ }
    // this PR's latest run only, and no PR that's been closed
    for (const d of await fs.readdir(work).catch(() => [])) {
      const m = /^pr-(\d+)$/.exec(d);
      if (m && (Number(m[1]) === pr || !open.has(Number(m[1])))) await fs.rm(path.join(work, d), { recursive: true, force: true });
    }
    const to = path.join(work, `pr-${pr}`, short(sha));
    await fs.mkdir(to, { recursive: true });
    for (const f of await fs.readdir(dir)) await fs.copyFile(path.join(dir, f), path.join(to, f));
    await fs.writeFile(path.join(to, "index.html"), player(sha, JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"))));
    await fs.writeFile(path.join(work, ".nojekyll"), "");
    await fs.writeFile(path.join(work, "index.html"), `<!doctype html><meta charset="utf-8"><title>dbx UI previews</title><p>Screenshots and recordings of <a href="https://github.com/${repo}/pulls">${repo}</a> pull requests, made by .github/workflows/ui-preview.yml.</p>`);
    git(["checkout", "-q", "--orphan", `tmp-${attempt}`], work);
    git(["add", "-A"], work);
    git(["commit", "-q", "-m", `ui preview for #${pr} at ${short(sha)}`], work);
    try {
      git(["push", "-q", `--force-with-lease=${BRANCH}:${base}`, remote, `HEAD:refs/heads/${BRANCH}`], work);
      await fs.rm(work, { recursive: true, force: true });
      return;
    } catch (e) {
      console.log(`push lost a race (${e.message.split("\n")[0]}), again`);
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 4000));
    }
  }
  throw new Error("couldn't push the preview");
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// the page the video plays on: GitHub shows no video it didn't host itself
function player(sha, m) {
  const shots = m.scenes.flatMap((s) => s.shots.map((x) => ({ ...x, scene: s.title })));
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>#${pr} 界面预览 · ${short(sha)}</title>
<style>:root{color-scheme:light dark;--bg:#f6f6f7;--fg:#1d1d1f;--muted:#6e6e73;--card:#fff;--line:#e5e5ea}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#f2f2f4;--muted:#9a9aa0;--card:#1c1c1f;--line:#2c2c30}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif}
main{max-width:1200px;margin:0 auto;padding:28px 16px 60px}h1{font-size:20px;margin:0 0 4px}.m{color:var(--muted);font-size:13px;margin:0 0 20px}
video,img{display:block;width:100%;border-radius:10px;border:1px solid var(--line);background:var(--card)}figure{margin:0 0 28px}figcaption{color:var(--muted);font-size:13px;margin-top:8px}
a{color:inherit}</style>
<main><h1>#${pr} 界面预览</h1><p class="m">commit ${short(sha)} · <a href="https://github.com/${repo}/pull/${pr}">回到 PR</a>${m.summary ? " · " + esc(m.summary) : ""}</p>
${m.video ? `<figure><video src="${m.video}" controls autoplay muted playsinline poster="${m.poster || ""}"></video><figcaption>红线是鼠标走过的轨迹，红色圆环是一次点击；底部文字是这一步在做什么。空格暂停，← → 逐段查看。</figcaption></figure>` : ""}
${shots.map((x) => `<figure><img src="${esc(x.file)}" alt="${esc(x.caption)}"><figcaption>${esc(x.scene)} · ${esc(x.caption)}</figcaption></figure>`).join("\n")}
</main></html>`;
}

async function pagesURL() {
  try { return (await gh(`/repos/${repo}/pages`)).html_url.replace(/\/?$/, "/"); }
  catch { const [o, n] = repo.split("/"); return `https://${o.toLowerCase()}.github.io/${n}/`; }
}

async function publish() {
  const p = await gh(`/repos/${repo}/pulls/${pr}`);
  const sha = process.env.SHA || p.head.sha;
  const dir = process.env.OUT_DIR;
  const result = process.env.RECORD_RESULT || "success";
  let m = null;
  try { m = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")); } catch {}
  if (result === "cancelled" && !m) return; // a newer commit took over
  if (!m || m.leak || (!m.scenes.some((s) => s.shots.length) && !m.video)) {
    const why = m?.leak ? "录制时屏幕上出现了密钥，已全部丢弃，没有发布任何截图"
      : m?.skipped === "no visible UI change found in the diff" ? "看了改动，没有找到用户能看到的界面变化，所以没有录制"
      : `这次没录成（${result}）`;
    const errs = m?.errors?.length ? `\n\n<details><summary>细节</summary>\n\n${m.errors.map((e) => "- " + e).join("\n")}\n</details>` : "";
    await setBlock(`${head(sha)}\n${m?.summary ? `**改动**（按代码）：${m.summary}\n\n` : ""}${m?.mismatch ? `> [!WARNING]\n> **描述与代码不符**：${m.mismatch}\n\n` : ""}${why}。${runURL ? `详见[运行记录](${runURL})。` : ""}${errs}`);
    return;
  }
  await pushMedia(sha, dir);
  const raw = `https://raw.githubusercontent.com/${repo}/${BRANCH}/pr-${pr}/${short(sha)}/`;
  const site = `${await pagesURL()}pr-${pr}/${short(sha)}/`;
  let md = `${head(sha)}\n`;
  if (m.summary) md += `**改动**（按代码）：${m.summary}\n\n`;
  if (m.mismatch) md += `> [!WARNING]\n> **描述与代码不符**：${m.mismatch}\n\n`;
  if (m.unseen) md += `> [!NOTE]\n> **沙盒里看不到**：${m.unseen}\n\n`;
  if (m.video) {
    md += `[![播放录屏](${raw}${m.poster})](${site})\n\n`;
    md += `<sub>▶️ 点图打开录屏（可暂停、拖动）· [直接下载 mp4](${raw}${m.video}) · 红线是鼠标轨迹，红色圆环是点击</sub>\n\n`;
  }
  for (const s of m.scenes) {
    if (!s.shots.length) continue;
    md += `#### ${s.title}\n\n`;
    // shown at its own size (they're taken at 2x), a full page no wider than 760
    for (const x of s.shots) md += `<img src="${raw}${x.file}" width="${Math.min(760, Math.round((x.width || 1520) / 2))}" alt="${esc(x.caption)}">\n\n${x.caption}\n\n`;
  }
  if (m.errors?.length) md += `<details><summary>⚠️ 有 ${m.errors.length} 步没能照计划执行</summary>\n\n${m.errors.map((e) => "- " + e).join("\n")}\n</details>\n`;
  await setBlock(md);
}

const cmd = process.argv[2];
(cmd === "detect" ? detect() : cmd === "publish" ? publish() : Promise.reject(new Error("detect | publish")))
  .catch((e) => { console.error(e); process.exit(1); });
