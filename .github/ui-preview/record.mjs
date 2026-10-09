// Records a PR's UI changes in the real app: dbx-web is already running
// (run.sh), this reads the PR's diff, has DeepSeek plan what to show from it
// and the page as it really is, then walks the plan in Chromium with the
// mouse drawn in (cursor.js) — screenshots always, a video when the change
// needs clicking to see. Everything lands in OUT_DIR with a manifest.json
// that publish.mjs turns into the PR's preview.
//
// env: DBX_URL (the app's link), DIFF_FILE, PR_TITLE, PR_BODY_FILE, OUT_DIR,
// SRC_DIR (the PR's source, for code context), DEEPSEEK_API_KEY, SECRETS
// (words that must never be on screen, one per line), UI_LOCALE (zh-CN),
// PLAN_MODEL, PLAN_FILE (a plan to walk instead of asking for one).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d) => process.env[k] ?? d;
const OUT = path.resolve(process.env.OUT_DIR || "ui-preview-out");
// a leak empties OUT, so it must be a folder of its own: not the working
// folder, the home, the root or one holding them
for (const keep of [process.cwd(), os.homedir(), path.parse(OUT).root]) {
  const rel = path.relative(OUT, keep);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    console.error(`record: OUT_DIR ${OUT} holds ${keep}; give it a folder of its own`);
    process.exit(1);
  }
}
const BASE = env("DBX_URL");
const LOCALE = env("UI_LOCALE", "zh-CN");
const MODEL = env("PLAN_MODEL", "deepseek-flash");
const VIEW = { width: 1440, height: 900 };
// never pressed: they delete the sandbox's own data or its setup
const FORBIDDEN = /删除|清空|移除|卸载|重置|格式化|delete|remove|clear all|drop\b|truncate\b/i;
const secrets = env("SECRETS", "").split("\n").map((s) => s.trim()).filter((s) => s.length >= 8);

const log = (...a) => console.log("[ui-preview]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const manifest = { summary: "", scenes: [], video: null, poster: null, errors: [], leak: false, skipped: null };

// The page as a compact outline the planner can pick real selectors from:
// visible elements, their tag, id, classes, a few data- attributes and
// their own text, indented; svg insides and invisible parts left out.
function outline() {
  const lines = [];
  const MAX = 420;
  const own = (e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").replace(/\s+/g, " ").slice(0, 70);
  const shown = (e) => {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = getComputedStyle(e);
    return s.visibility !== "hidden" && s.display !== "none" && +s.opacity !== 0;
  };
  // fold: where the view it is in ends on screen
  const walk = (e, depth, fold) => {
    if (lines.length >= MAX || e.hasAttribute?.("data-ui-preview")) return;
    const tag = e.tagName.toLowerCase();
    if (["script", "style", "svg", "link", "meta", "noscript", "template"].includes(tag) || !shown(e)) return;
    const cls = [...e.classList].slice(0, 4).map((c) => "." + c).join("");
    const data = [...e.attributes].filter((a) => a.name.startsWith("data-") && a.value.length < 40).slice(0, 3).map((a) => `[${a.name}="${a.value}"]`).join("");
    const aria = ["role", "aria-label", "title", "placeholder", "type"].map((k) => e.getAttribute(k) ? `${k}="${e.getAttribute(k).slice(0, 40)}"` : "").filter(Boolean).join(" ");
    const text = own(e);
    const r = e.getBoundingClientRect();
    const away = r.top >= fold ? " (below the fold)" : "";
    const interesting = cls || data || e.id || text || aria || /^(button|a|input|select|textarea|label|h\d)$/.test(tag);
    if (interesting) lines.push(`${"  ".repeat(Math.min(depth, 12))}${tag}${e.id ? "#" + e.id : ""}${cls}${data}${aria ? " " + aria : ""}${text ? ` "${text}"` : ""}${away}`);
    const scrolls = /auto|scroll|overlay/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1;
    for (const c of e.children) walk(c, interesting ? depth + 1 : depth, scrolls ? Math.min(fold, r.bottom) : fold);
  };
  walk(document.body, 0, innerHeight);
  if (lines.length >= MAX) lines.push("… (cut)");
  return lines.join("\n");
}

async function screenText(page) {
  return page.evaluate(() => document.documentElement.innerText + "\n" +
    [...document.querySelectorAll("input, textarea")].map((e) => e.value).join("\n")).catch(() => "");
}
async function checkLeak(page, where) {
  if (!secrets.length) return;
  const text = await screenText(page);
  for (const s of secrets) {
    // the whole key, or a long enough run of its middle
    const mid = s.slice(4, -4);
    if (text.includes(s) || (mid.length >= 12 && text.includes(mid))) {
      manifest.leak = true;
      throw new Error(`a secret is on screen (${where}); nothing will be published`);
    }
  }
}

async function deepseek(messages) {
  // a reply cut short or not JSON is asked for again
  let last;
  for (let i = 0; i < 3; i++) {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("DEEPSEEK_API_KEY")}` },
      body: JSON.stringify({ model: MODEL, messages, response_format: { type: "json_object" }, max_tokens: 16000 }),
      signal: AbortSignal.timeout(240e3),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content ?? "";
    try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s+```$/g, "")); }
    catch (e) { last = new Error(`reply not JSON (${j.choices?.[0]?.finish_reason}): ${e.message}`); log(last.message, "— asking again"); }
  }
  throw last;
}

// Two things for the planner, from the PR's source:
//
// 1. the changed frontend files themselves — a Vue component's template is
//    the surest guide to the selectors it renders;
// 2. the entry chains to them: a dialog or panel the diff touches is often
//    rendered by some other component that isn't in the diff, opened by a
//    condition the diff never shows. For each changed .vue component we
//    grep the frontend for who imports it and under what v-if/v-show it is
//    rendered, then for who flips those conditions — the magpie-style
//    two-hop caller walk, adapted to Vue.
const SKIP = /(__tests__|\.spec\.|\.test\.|\.bench\.|^apps\/desktop\/src\/i18n\/locales\/)/;
async function readTree(root) {
  const out = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(vue|ts)$/.test(e.name)) out.push(p);
    }
  };
  await walk(root);
  return out;
}

async function codeContext(diff, src) {
  if (!src) return "";
  const changed = [...new Set([...diff.matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map((m) => m[1]))]
    .filter((f) => /^apps\/desktop\/src\//.test(f) && !SKIP.test(f.slice("apps/desktop/src/".length - 1)) && !SKIP.test(f));

  // 1. the changed files
  let out = "";
  for (const f of changed.slice(0, 12)) {
    let body;
    try { body = await fs.readFile(path.join(src, f), "utf8"); } catch { continue; }
    const chunk = `--- ${f}\n${body.length > 8000 ? body.slice(0, 8000) + "\n… (cut)" : body}\n`;
    if (out.length + chunk.length > 20e3) { out += "… (cut)\n"; break; }
    out += chunk;
  }

  // 2. entry chains: who renders the changed components, and who opens that
  const components = changed.filter((f) => f.endsWith(".vue")).map((f) => path.basename(f, ".vue"));
  if (!components.length) return out;
  const rel = (p) => path.relative(src, p);
  const files = (await readTree(path.join(src, "apps/desktop/src"))).filter((p) => !SKIP.test(rel(p)));
  const texts = new Map();
  const read = async (p) => {
    if (!texts.has(p)) {
      const b = await fs.readFile(p, "utf8").catch(() => "");
      texts.set(p, b.length > 400e3 ? "" : b);
    }
    return texts.get(p);
  };
  let entries = "";
  for (const name of components.slice(0, 6)) {
    const kebab = name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    const re = new RegExp(
      "import\\s+" + name + "\\b" +
      "|from\\s+[\"'][^\"']*/" + name + "(\\.vue)?[\"']" +
      "|import\\(\\s*[\"'][^\"']*/" + name + "(\\.vue)?[\"']\\s*\\)" +
      "|<" + kebab + "[\\s>/]|<" + name + "[\\s>/]");
    const flags = new Map(); // caller file -> Set of line numbers
    for (const p of files) {
      const t = await read(p);
      if (!t || rel(p).endsWith(`/${name}.vue`)) continue;
      t.split("\n").forEach((l, i) => { if (re.test(l)) (flags.get(p) ?? flags.set(p, new Set()).get(p)).add(i); });
    }
    for (const [p, lines] of flags) {
      // a dynamic import renames the component (const X = defineAsyncComponent):
      // resolve the local aliases, then mark where they are rendered — that
      // line, not the import, carries the v-if that shows it
      const ls = await read(p);
      const linesArr = ls.split("\n");
      const aliases = new Set([name]);
      for (const i of lines) {
        const m = /(?:import\s+(\w+)\s+from|const\s+(\w+)\s*=\s*(?:defineAsyncComponent|shallowRef|markRaw))/.exec(linesArr[i]);
        if (m && re.test(linesArr[i])) aliases.add(m[1] || m[2]);
      }
      if (aliases.size > 1) {
        const tagRe = new RegExp("<(?:" + [...aliases].join("|") + "|" + [...aliases].map((a) => a.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()).join("|") + ")[\\s>/]");
        linesArr.forEach((l, i) => { if (tagRe.test(l)) lines.add(i); });
      }
      // the usage with its v-if/v-show/:open condition, and identifiers in it
      const span = [];
      for (const i of lines) span.push(linesArr.slice(Math.max(0, i - 6), i + 14).join("\n"));
      const cond = span.join("\n");
      const chunk = `--- ${rel(p)} renders ${name} (how it is shown):\n${cond.slice(0, 2500)}\n`;
      if (entries.length + chunk.length > 9e3) { entries += "… (cut)\n"; break; }
      entries += chunk;
      // who flips those conditions: identifiers in v-if / :open / v-model near the usage
      const ids = [...new Set([...cond.matchAll(/(?:v-if|v-show|:open|v-model:open|:model-value)="\s*([A-Za-z_$][\w$.]*)/g)].map((m) => m[1]))].slice(0, 4);
      for (const id of ids) {
        const base = id.split(".").pop();
        const flip = new RegExp("\\b" + base + "\\s*=\\s*(true|false|!)|(?:function|const)\\s+" + base + "\\b|\\b" + base + "\\s*\\(");
        let shown = 0;
        for (const q of files) {
          if (shown >= 2) break;
          const qt = await read(q);
          if (!qt) continue;
          const qArr = qt.split("\n");
          for (let i = 0; i < qArr.length && shown < 2; i++) {
            if (!flip.test(qArr[i]) || re.test(qArr[i])) continue;
            const c = `--- ${rel(q)} flips ${id}:\n${qArr.slice(Math.max(0, i - 8), i + 8).join("\n")}\n`;
            if (entries.length + c.length > 12e3) break;
            entries += c;
            shown++;
          }
        }
      }
    }
  }
  return out + (entries ? `\n=== how the changes are reached (other components rendering/opening them — the entry points to plan from) ===\n${entries}` : "");
}

const GUIDE = `You plan a short screen recording of dbx, a database GUI (shown here in a browser at ${VIEW.width}x${VIEW.height}). It runs for real on a sandbox machine: the web build of the app against a dbx-web backend with password protection off, and made-up data beside it (seed.mjs) so the pages that need data have some. That data: two saved SQLite connections, "商店 Shop (SQLite)" (tables customers, products, orders, audit_log, a view v_daily_revenue, foreign keys and a trigger) and "分析 Analytics (SQLite)" (events with 5000 rows — the grid pages — and daily_stats with 90 days); a small sample.csv (name,category,price,stock) for import dialogs; a saved-SQL folder "常用查询" with three files; and query history over the last three days across both connections, real executions mixed with seeded entries, a few failures among them. The UI language is ${LOCALE}. What it doesn't have: any server database (MySQL, PostgreSQL, Redis, MongoDB… none are connected — connection dialogs can be opened but not completed), no AI provider configured, no plugins or JDBC drivers installed, no SSH tunnels.

dbx is a single-page app with no URL routing: every recording starts from the page as it opens. The left sidebar lists the connections; opening one (double-click, or right-click → its menu) opens its tables and its tabs — the query editor, table data, structure, ER diagram; the toolbar above the editor runs the SQL; other panels (SQL 库, 查询历史, 全局搜索, 设置) open from the interface itself. Find your way from the outline you are given. Two ways of working that reach further than clicks:
- The query editor runs any SQL against the sandbox's SQLite databases (they are throwaway — writes are fine): when a state needs data (a result with no columns, an empty table, a table of a shape), open a connection, type the SQL that produces it and run it, and show the state it makes.
- A file picker can't be clicked through, but a step can set it: { "do": "upload", "target": "input[type=file]", "value": "sample.csv" } — seed.mjs puts sample.csv (a small product list: name,category,price,stock) beside the databases, for import and mapping dialogs.

The diff is what the PR does. The title and description are the author's words and may be out of date or wrong: plan and summarise from the diff alone, and when the description claims something in the UI the diff doesn't do (a setting, a page, a button), don't look for it — say so in "mismatch".

You get the PR's title, description, diff, an outline of the app as it renders now, the changed frontend files themselves, and the entry chains: the other components that render the changed ones, under what v-if/v-show condition they are shown, and the code that flips those conditions. Use only selectors you can build from what the outline shows, or, for what only appears after an interaction (a dialog, a context menu, a dropdown, a tab), from the changed files and entry chains: the outline shows the app at rest, so an element the diff styles or builds being missing from it means you must open it first, not that it isn't there. The entry chains are the map — when a selector from the diff is nowhere in the outline, plan the steps that flip its condition (the toolbar button, the context menu, the tab the entry chain names), and don't search random other pages for it.

Write a plan that shows a reviewer exactly what this PR changes in the UI and whether it works as intended: go where the change is, do what a user would do to see it (open the connection, switch the tab, type the SQL, open the dialog…), and take a screenshot at each state that matters, before and after an interaction when that is the point. Put a wish for text in the step's "text" field, never inside the target selector ([aria-label="设置"] hides it from the runner's text fallback — target "button" with text "设置" instead). Captions say what is being done or what to look at ("打开订单表后的数据网格"), never what the result is or should be — the reviewer judges that from the picture, and the sandbox may differ from what you expect; and they never name a thing the diff doesn't add. When the change only shows with data this sandbox doesn't have (a server database, a plugin), say so in "unseen" and still show the place it would be. Keep it short: usually 1–3 scenes, under 15 steps each. Don't show unrelated pages. Never press anything that deletes, removes, clears or resets (删除/清空/移除/重置), and never run SQL that drops or truncates. Say ui_change false (and no scenes) only when the diff plainly changes nothing a user can see — only tests, comments, docs, or code that never reaches the screen; any change to the page's CSS, markup, text or behaviour is a UI change.

Reply with JSON only:
{
  "ui_change": true,
  "summary": "one or two sentences, in Chinese, on what the diff changes in the UI",
  "mismatch": "Chinese, or empty: what the description says the UI gets that the diff doesn't do",
  "unseen": "Chinese, or empty: what of the change this sandbox can't show, and why",
  "scenes": [
    { "title": "short Chinese title", "start": "app",
      "steps": [
        { "do": "click", "target": "css selector", "text": "optional: only elements containing this text", "dblclick": false, "caption": "Chinese caption shown in the video" },
        { "do": "hover", "target": "…", "caption": "…" },
        { "do": "type", "target": "…", "value": "text to type", "caption": "…" },
        { "do": "upload", "target": "input[type=file]", "value": "sample.csv", "caption": "…" },
        { "do": "press", "key": "Escape" },
        { "do": "scroll", "to": "css selector of what to bring into view", "text": "optional" },
        { "do": "scroll", "target": "optional scroll container", "dy": 400 },
        { "do": "wait", "ms": 800 },
        { "do": "shot", "name": "kebab-case-name", "caption": "Chinese: what this screenshot shows", "target": "optional: capture just this element (with some room around it)" }
      ] }
  ]
}`;

// the mouse glides like a hand would, so its trail reads in the video
let mouse = { x: VIEW.width / 2, y: VIEW.height / 2 };
async function glide(page, x, y) {
  const d = Math.hypot(x - mouse.x, y - mouse.y);
  const ms = Math.min(900, Math.max(250, d * 1.1));
  const n = Math.max(8, Math.round(ms / 16));
  const from = { ...mouse };
  for (let i = 1; i <= n; i++) {
    const t = i / n, e = t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    // a slight arc, not a ruler line
    const bend = Math.sin(Math.PI * t) * Math.min(40, d * .08);
    const nx = from.x + (x - from.x) * e - ((y - from.y) / (d || 1)) * bend;
    const ny = from.y + (y - from.y) * e + ((x - from.x) / (d || 1)) * bend;
    await page.mouse.move(nx, ny);
    await sleep(16);
  }
  mouse = { x, y };
}

async function locate(page, step) {
  if (!step.target) throw new Error(`${step.do} needs a target`);
  let loc = page.locator(step.target);
  // a wish for text tucked into the selector ([aria-label="设置"], [title="Run"]):
  // take it out and treat it as the text filter, where the fallback can use it
  const attrText = /\[(?:aria-label|title|placeholder|data-slot|data-view)[*^$]?=~?"([^"]+)"/.exec(step.target)?.[1];
  if (!step.text && attrText) {
    step = { ...step, text: attrText };
    loc = loc.filter({ hasText: attrText });
  }
  if (step.text) loc = loc.filter({ hasText: step.text });
  const visible = async (l) => {
    const n = await l.count();
    for (let i = 0; i < n; i++) {
      const one = l.nth(i);
      if (await one.isVisible()) return one;
    }
    return null;
  };
  const hit = await visible(loc);
  if (hit) return hit;
  // the selector guessed a role or structure this app doesn't use (a tab, a
  // menuitem, a tree node…): fall back to the one visible thing carrying the
  // text — only when exactly one is on screen, so a wrong guess fails loud
  if (step.text) {
    const loose = page.locator('button, a, li, span, div[class]:not([class=""]), [role="menuitem"], [role="tab"], [role="button"], [role="treeitem"], [class*="categor"] *, [class*="nav"] *, [class*="tree"] *, [class*="sidebar"] *').filter({ hasText: step.text });
    const seen = [];
    const n = await loose.count();
    for (let i = 0; i < n && seen.length <= 2; i++) {
      const one = loose.nth(i);
      if (await one.isVisible()) seen.push(one);
    }
    // at most two on screen (the same text in a parent and its child): take
    // the last, which in DOM order is the innermost; more means the wish for
    // the text is too vague — fail loud rather than click something wrong
    if (seen.length >= 1 && seen.length <= 2) return seen.at(-1);
  }
  throw new Error(`nothing visible matches ${step.target}${step.text ? ` with "${step.text}"` : ""} (${await loc.count()} in the page)`);
}

// Out of sight is scrolled to as a reader would, with the wheel over what
// scrolls. Each view that hides it, the innermost first, is wheeled in small
// steps until the element is in the middle of it, or at its top when it's
// taller.
async function bringIntoView(page, loc) {
  const PAD = 24;
  for (let pass = 0; pass < 6; pass++) {
    const views = await loc.evaluate((e, PAD) => {
      const out = [];
      const clip = { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
      const scrollers = [];
      for (let s = e.parentElement; s; s = s.parentElement) {
        const root = s === document.scrollingElement;
        const o = getComputedStyle(s).overflowY;
        if ((root || /auto|scroll|overlay/.test(o)) && s.scrollHeight > s.clientHeight + 1) scrollers.push(s);
      }
      const r = e.getBoundingClientRect();
      for (const s of scrollers) {
        const root = s === document.scrollingElement;
        const b = root ? clip : s.getBoundingClientRect();
        // what of it shows: inside the window and every view around it
        let top = Math.max(b.top, 0), bottom = Math.min(b.bottom, innerHeight);
        let left = Math.max(b.left, 0), right = Math.min(b.right, innerWidth);
        for (let p = s.parentElement; p && !root; p = p.parentElement) {
          if (!scrollers.includes(p) || p === document.scrollingElement) continue;
          const pb = p.getBoundingClientRect();
          top = Math.max(top, pb.top); bottom = Math.min(bottom, pb.bottom);
          left = Math.max(left, pb.left); right = Math.min(right, pb.right);
        }
        const room = bottom - top - 2 * PAD;
        const want = r.height <= room ? (r.top + r.bottom) / 2 - (top + bottom) / 2 : r.top - (top + PAD);
        const shown = r.top >= top + Math.min(PAD, Math.max(0, room - r.height) / 2) && (r.height <= room ? r.bottom <= bottom - PAD : r.top <= top + PAD * 2);
        out.push({ shown, dy: Math.max(-s.scrollTop, Math.min(s.scrollHeight - s.clientHeight - s.scrollTop, want)),
          x: (left + right) / 2, y: (top + bottom) / 2, seen: bottom - top > 20 && right - left > 20 });
      }
      return out;
    }, PAD);
    const v = views.find((v) => !v.shown && Math.abs(v.dy) >= 4 && v.seen);
    if (!v) return;
    await glide(page, v.x, v.y);
    await wheel(page, v.dy);
    await sleep(350);
  }
}

// a hand's flick: a few notches at a time, not one jump
async function wheel(page, dy) {
  for (let left = dy; Math.abs(left) >= 1;) {
    const n = Math.sign(left) * Math.min(Math.abs(left), 90);
    await page.mouse.wheel(0, n);
    left -= n;
    await sleep(28);
  }
}

async function pointAt(page, loc) {
  await bringIntoView(page, loc);
  const b = await loc.boundingBox();
  if (!b) throw new Error("the element has no box");
  const x = b.x + Math.min(b.width / 2, 60), y = b.y + b.height / 2;
  await glide(page, x, y);
  return b;
}

// The app polls, so the network never goes quiet: loaded, its toolbar and
// the seeded connections painted in, is ready
async function settle(page) {
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForFunction(() => {
    const txt = document.body.innerText || "";
    return txt.includes("新建连接") || txt.includes("New Connection") || document.querySelectorAll("button").length >= 6;
  }, null, { timeout: 20000 }).catch(() => {});
  await sleep(1500);
}

const caption = (page, text) => page.evaluate((t) => window.__uiPreviewCaption?.(t), text || "").catch(() => {});
let shotN = 0;

async function runStep(page, step, scene) {
  if (step.caption) await caption(page, step.caption);
  switch (step.do) {
    case "click": {
      const loc = await locate(page, step);
      const label = (await loc.innerText().catch(() => "")) + " " + (await loc.getAttribute("title").catch(() => "") || "");
      if (FORBIDDEN.test(label)) throw new Error(`won't press "${label.trim().slice(0, 40)}"`);
      await pointAt(page, loc);
      await sleep(180);
      if (step.dblclick) {
        await page.mouse.down(); await sleep(60); await page.mouse.up();
        await sleep(120); await page.mouse.down(); await sleep(60); await page.mouse.up();
      } else {
        await page.mouse.down();
        await sleep(90);
        await page.mouse.up();
      }
      // a click that opens something (a menu, the settings, a dialog) needs
      // its new DOM painted before the next step looks for it
      await sleep(1200);
      break;
    }
    case "hover": {
      await pointAt(page, await locate(page, step));
      await sleep(900);
      break;
    }
    case "type": {
      const loc = await locate(page, step);
      await pointAt(page, loc);
      await page.mouse.down(); await sleep(80); await page.mouse.up();
      await loc.fill("");
      await page.keyboard.type(String(step.value ?? ""), { delay: 70 });
      await sleep(600);
      break;
    }
    case "upload": {
      // a file for an <input type=file>: the name is resolved inside SEED_DIR
      // (seed.mjs puts a sample CSV there) — the OS picker can't be driven
      const loc = step.target ? await locate(page, step) : page.locator('input[type="file"]').first();
      const dir = env("SEED_DIR", ".");
      const file = path.resolve(dir, String(step.value ?? step.file ?? "sample.csv"));
      await loc.setInputFiles(file);
      await sleep(800);
      break;
    }
    case "press":
      await page.keyboard.press(step.key || "Escape");
      await sleep(500);
      break;
    case "scroll": {
      if (step.to) {
        await bringIntoView(page, await locate(page, { ...step, target: step.to }));
        await sleep(400);
        break;
      }
      // over the view to scroll, or the page's middle: the wheel turns what's under the mouse
      if (step.target) await pointAt(page, await locate(page, step));
      else if (mouse.y < 60) await glide(page, VIEW.width / 2, VIEW.height / 2);
      await wheel(page, step.dy ?? 400);
      await sleep(700);
      break;
    }
    case "wait":
      await sleep(Math.min(step.ms ?? 800, 4000));
      break;
    case "shot": {
      // in sight first, scrolled to on camera: the clip is of the screen
      const loc = step.target ? await locate(page, step) : null;
      if (loc) await bringIntoView(page, loc);
      await sleep(250);
      await checkLeak(page, `before ${step.name}`);
      const file = `${String(++shotN).padStart(2, "0")}-${(step.name || "shot").replace(/[^a-z0-9-]/gi, "-").slice(0, 40)}.png`;
      // the screenshot without the drawn mouse and caption
      await page.evaluate(() => document.querySelector("[data-ui-preview]")?.style.setProperty("visibility", "hidden"));
      let clip;
      try {
        if (loc) {
          const b = await loc.boundingBox();
          if (b) {
            // the target with room around it, never so small that a button
            // is shown without where it is
            const w = Math.min(VIEW.width, Math.max(560, b.width + 48)), h = Math.min(VIEW.height, Math.max(340, b.height + 48));
            const x = Math.min(VIEW.width - w, Math.max(0, b.x + b.width / 2 - w / 2));
            const y = Math.min(VIEW.height - h, Math.max(0, b.y + b.height / 2 - h / 2));
            clip = { x, y, width: w, height: h };
          }
        }
        await page.screenshot({ path: path.join(OUT, file), clip });
      } finally {
        await page.evaluate(() => document.querySelector("[data-ui-preview]")?.style.removeProperty("visibility"));
      }
      scene.shots.push({ file, caption: step.caption || step.name || "", width: 2 * (clip?.width ?? VIEW.width) });
      break;
    }
    default:
      throw new Error(`unknown step ${step.do}`);
  }
  if (step.do !== "shot") await checkLeak(page, `after ${step.do}`);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const diff = await fs.readFile(env("DIFF_FILE"), "utf8");
  const body = await fs.readFile(env("PR_BODY_FILE", "/dev/null"), "utf8").catch(() => "");
  const browser = await chromium.launch();
  const ctxOpts = { viewport: VIEW, deviceScaleFactor: 2, locale: LOCALE, colorScheme: "light" };

  // what the app looks like now, for the plan
  const look = await browser.newContext(ctxOpts);
  const lp = await look.newPage();
  const outlines = {};
  try {
    await lp.goto(BASE);
    await settle(lp);
    outlines.app = await lp.evaluate(outline);
  } catch (e) { outlines.app = `(failed to load: ${e.message})`; }
  await look.close();

  const MAXDIFF = 150e3;
  const code = await codeContext(diff, env("SRC_DIR")).catch((e) => (log("code context:", e.message), ""));
  log(`code context: ${code.length} characters`);
  const ask = [
    { role: "system", content: GUIDE },
    { role: "user", content: `PR title: ${env("PR_TITLE", "")}\n\nPR description:\n${body.slice(0, 6000)}\n\nDiff${diff.length > MAXDIFF ? " (cut)" : ""}:\n${diff.slice(0, MAXDIFF)}\n\n` +
      `=== outline: app ===\n${outlines.app}` +
      (code ? `\n\n=== the changed frontend files (the PR's version) ===\n${code}` : "") },
  ];
  let plan;
  try { plan = env("PLAN_FILE") ? JSON.parse(await fs.readFile(env("PLAN_FILE"), "utf8")) : await deepseek(ask); }
  catch (e) { plan = null; manifest.errors.push(`plan: ${e.message}`); }
  if (!plan || plan.ui_change === false || !plan.scenes?.length) {
    manifest.summary = plan?.summary || "";
    manifest.skipped = plan ? "no visible UI change found in the diff" : "no plan";
    // still something to look at: the app as it opens
    plan = { summary: manifest.summary, scenes: plan ? [] : [{ title: "应用主界面", start: "app", steps: [{ do: "shot", name: "app", caption: "应用主界面" }] }] };
  }
  manifest.summary = plan.summary || "";
  manifest.mismatch = plan.mismatch || "";
  manifest.unseen = plan.unseen || "";
  log("plan:", JSON.stringify(plan, null, 1));

  if (plan.scenes.length) {
    const rec = await browser.newContext({ ...ctxOpts, recordVideo: { dir: path.join(OUT, "raw"), size: VIEW } });
    await rec.addInitScript({ path: path.join(here, "cursor.js") });
    const page = await rec.newPage();
    const began = Date.now();
    let lead = 0, repairs = 0, interactive = false;
    for (const s of plan.scenes.slice(0, 5)) {
      const scene = { title: s.title || "", shots: [] };
      manifest.scenes.push(scene);
      try {
        await caption(page, scene.title);
        await page.goto(BASE);
        await settle(page);
        if (!lead) lead = Math.max(0, (Date.now() - began) / 1000 - 0.4);
        await page.evaluate(([x, y]) => window.__uiPreviewAt?.(x, y), [mouse.x, mouse.y]);
      } catch (e) { manifest.errors.push(`${scene.title}: open: ${e.message}`); if (manifest.leak) break; continue; }
      let steps = (s.steps || []).slice(0, 25);
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (["click", "hover", "type", "press", "scroll", "upload"].includes(step.do)) interactive = true;
        try { await runStep(page, step, scene); }
        catch (e) {
          if (manifest.leak) break;
          manifest.errors.push(`${scene.title} · ${step.do} ${step.target || step.name || ""}: ${e.message.split("\n")[0]}`);
          log("step failed:", e.message);
          if (repairs >= 3) continue;
          repairs++;
          // the page as it is now, and what went wrong: the rest of the scene again
          try {
            const fix = await deepseek([...ask, { role: "assistant", content: JSON.stringify(plan) },
              { role: "user", content: `Step ${i + 1} of scene "${scene.title}" failed: ${e.message.split("\n")[0]}\nThe page now:\n${await page.evaluate(outline)}\n\nIf the failed selector came from the diff, remember the changed-file paths above say which dialog, panel or component holds it — a different one may have to be opened (or closed) first, not just a different selector for this page. Reply with JSON {"steps": [...]}: the steps to do instead of that one and the ones after it in this scene.` }]);
            if (Array.isArray(fix.steps)) { steps = [...steps.slice(0, i + 1), ...fix.steps.slice(0, 20)]; log("repaired:", JSON.stringify(fix.steps)); }
          } catch (e2) { manifest.errors.push(`repair: ${e2.message}`); }
        }
      }
      if (manifest.leak) break;
      await caption(page, "");
      await sleep(600);
    }
    const video = await page.video().path();
    await rec.close();
    manifest.interactive = interactive;
    // a video when there's something to watch: an interaction
    if (!manifest.leak && interactive) {
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", lead.toFixed(2), "-i", video, "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", "30", path.join(OUT, "preview.mp4")]);
      manifest.video = "preview.mp4";
      manifest.poster = await poster(browser);
    }
    await fs.rm(path.join(OUT, "raw"), { recursive: true, force: true });
  }
  await browser.close();
  if (manifest.leak) {
    for (const f of await fs.readdir(OUT)) await fs.rm(path.join(OUT, f), { recursive: true, force: true });
    manifest.scenes = []; manifest.video = manifest.poster = null;
  }
  await fs.writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  log("done:", JSON.stringify({ shots: manifest.scenes.reduce((n, s) => n + s.shots.length, 0), video: manifest.video, errors: manifest.errors.length, leak: manifest.leak }));
}

// the video's still in the PR: a frame from the middle with a play button
async function poster(browser) {
  const frame = path.join(OUT, "frame.png");
  const dur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(OUT, "preview.mp4")]).toString()) || 2;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(Math.min(dur / 3, 6)), "-i", path.join(OUT, "preview.mp4"), "-frames:v", "1", frame]);
  const img = (await fs.readFile(frame)).toString("base64");
  const p = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
  await p.setContent(`<body style="margin:0;background:url(data:image/png;base64,${img}) center/cover;height:100vh;display:grid;place-items:center">
    <div style="position:absolute;inset:0;background:rgba(0,0,0,.28)"></div>
    <div style="position:relative;display:flex;align-items:center;gap:18px;padding:22px 34px 22px 26px;border-radius:999px;background:rgba(17,17,19,.78);color:#fff;font:600 30px -apple-system,'Segoe UI','Noto Sans CJK SC',sans-serif">
      <svg width="46" height="46" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#fff"/><path d="M9.5 7.5v9l7-4.5z" fill="#111"/></svg>
      播放录屏 · ${Math.round(dur)} 秒</div></body>`);
  await p.screenshot({ path: path.join(OUT, "poster.png") });
  await p.close();
  await fs.rm(frame);
  return "poster.png";
}

main().catch(async (e) => {
  console.error(e);
  manifest.errors.push(`recorder: ${e.message}`);
  await fs.mkdir(OUT, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2)).catch(() => {});
  process.exit(1);
});
