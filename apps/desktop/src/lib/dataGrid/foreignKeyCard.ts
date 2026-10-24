import type { CellValue } from "@/lib/dataGrid/cellValue";
import type { ColumnInfo } from "@/types/database";

/** 外键资讯卡的触发方式：点击卡片按钮开/关，或悬停到外键单元格即显示。 */
export type ForeignKeyCardTrigger = "click" | "hover";

export const DEFAULT_FOREIGN_KEY_CARD_TRIGGER: ForeignKeyCardTrigger = "click";

/** 被引用表的卡片模板：HTML，`{{column}}` 占位符替换为被引用记录的值（自动 HTML 转义）。 */
export interface ForeignKeyCardTemplate {
  html: string;
  updatedAt?: number;
}

export const FOREIGN_KEY_CARD_TEMPLATE_MAX_LENGTH = 64 * 1024;
const EXAMPLE_CARD_MAX_FIELDS = 8;
const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function normalizeForeignKeyCardTrigger(value: unknown): ForeignKeyCardTrigger {
  return value === "hover" ? "hover" : DEFAULT_FOREIGN_KEY_CARD_TRIGGER;
}

export function normalizeForeignKeyCardTemplates(value: unknown): Record<string, ForeignKeyCardTemplate> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const templates: Record<string, ForeignKeyCardTemplate> = {};
  for (const [key, template] of Object.entries(value as Record<string, unknown>)) {
    if (!key || !template || typeof template !== "object") continue;
    const html = (template as { html?: unknown }).html;
    if (typeof html !== "string" || !html.trim() || html.length > FOREIGN_KEY_CARD_TEMPLATE_MAX_LENGTH) continue;
    const updatedAt = (template as { updatedAt?: unknown }).updatedAt;
    templates[key] = typeof updatedAt === "number" && Number.isFinite(updatedAt) ? { html, updatedAt } : { html };
  }
  return templates;
}

/** 模板按被引用表归属：同一张表被多个外键引用时共用一份卡片。 */
export function foreignKeyCardTemplateKey(options: { connectionId: string; database?: string; catalog?: string; schema?: string; table: string }): string {
  return JSON.stringify([options.connectionId, options.database ?? "", options.catalog ?? "", options.schema ?? "", options.table]);
}

/** 模板引用到的列（去重、保持出现顺序）；只保留真实存在的列，大小写不敏感。 */
export function foreignKeyCardTemplateColumns(html: string, availableColumns: readonly string[]): string[] {
  const byLower = new Map(availableColumns.map((column) => [column.toLowerCase(), column]));
  const columns: string[] = [];
  for (const match of html.matchAll(PLACEHOLDER_PATTERN)) {
    const column = byLower.get(match[1].trim().toLowerCase());
    if (column && !columns.includes(column)) columns.push(column);
  }
  return columns;
}

export function escapeForeignKeyCardHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function foreignKeyCardValueText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 用记录替换占位符；未知列留空。值一律转义，模板作者无法通过数据注入标签。 */
export function fillForeignKeyCardTemplate(html: string, record: Readonly<Record<string, CellValue | undefined>>): string {
  const byLower = new Map(Object.entries(record).map(([column, value]) => [column.toLowerCase(), value]));
  return html.replace(PLACEHOLDER_PATTERN, (_, name: string) => escapeForeignKeyCardHtml(foreignKeyCardValueText(byLower.get(name.trim().toLowerCase()))));
}

const BLOCKED_ELEMENTS = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "link", "meta", "base", "form", "input", "button", "textarea", "select", "noscript", "template", "portal"]);
const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href", "action", "formaction", "poster", "srcset", "background"]);

function unsafeUrl(value: string): boolean {
  // 浏览器解析 URL 时忽略空白与控制字符（"java\tscript:" 同样会执行），比较前先去掉。
  const normalized = Array.from(value)
    .filter((char) => char.charCodeAt(0) > 0x20)
    .join("")
    .toLowerCase();
  if (normalized.startsWith("javascript:") || normalized.startsWith("vbscript:")) return true;
  return normalized.startsWith("data:") && !/^data:image\/(png|jpe?g|gif|webp|bmp|avif);/.test(normalized);
}

/**
 * 卡片 HTML 由用户或 AI 编写、渲染在 Shadow DOM 中：样式天然隔离，这里只需剥掉
 * 可执行内容（脚本、事件属性、javascript: 链接、嵌入对象、表单）。
 */
export function sanitizeForeignKeyCardHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walker = doc.body.querySelectorAll("*");
  for (const element of Array.from(walker)) {
    const tag = element.tagName.toLowerCase();
    if (BLOCKED_ELEMENTS.has(tag)) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || (URL_ATTRIBUTES.has(name) && unsafeUrl(attribute.value))) element.removeAttribute(attribute.name);
      else if (name === "style" && /expression\s*\(|url\s*\(\s*['"]?\s*javascript:/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  return doc.body.innerHTML;
}

export function renderForeignKeyCardHtml(html: string, record: Readonly<Record<string, CellValue | undefined>>): string {
  return sanitizeForeignKeyCardHtml(fillForeignKeyCardTemplate(html, record));
}

const AVATAR_COLUMN = /(avatar|photo|picture|image|img|logo|icon|thumbnail|portrait)/i;
const TITLE_COLUMN = /^(display_?name|full_?name|name|nickname|nick_?name|username|user_?name|title|label|email)$/i;

/** 没有自定义模板时：以表格列出被引用记录的全部列。 */
export function fullRecordForeignKeyCardHtml(columns: readonly string[]): string {
  const rows = columns.map((column) => `<tr><th>${escapeForeignKeyCardHtml(column)}</th><td>{{${column}}}</td></tr>`).join("");
  return `<style>
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 4px 6px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
tr:last-child th, tr:last-child td { border-bottom: 0; }
th { width: 1%; white-space: nowrap; font-weight: 400; color: var(--muted-foreground); }
td { word-break: break-all; }
</style>
<table>${rows}</table>`;
}

/** 编辑器的「插入范例排版」：识别头像/标题列，再挑几个字段排成键值表，作为自定义的起点。 */
export function exampleForeignKeyCardHtml(columns: readonly string[]): string {
  const avatar = columns.find((column) => AVATAR_COLUMN.test(column));
  const title = columns.find((column) => TITLE_COLUMN.test(column));
  const fields = columns.filter((column) => column !== avatar && column !== title).slice(0, EXAMPLE_CARD_MAX_FIELDS);
  const header = avatar || title ? `<div class="head">${avatar ? `<img class="avatar" src="{{${avatar}}}" alt="">` : ""}${title ? `<div class="title">{{${title}}}</div>` : ""}</div>` : "";
  const rows = fields.map((column) => `<dt>${escapeForeignKeyCardHtml(column)}</dt><dd>{{${column}}}</dd>`).join("");
  return `<style>
.card { font-size: 12px; color: var(--foreground); }
.head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.avatar { width: 40px; height: 40px; border-radius: 9999px; object-fit: cover; background: var(--muted); }
.title { font-size: 14px; font-weight: 600; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
dt { color: var(--muted-foreground); }
dd { margin: 0; word-break: break-all; }
</style>
<div class="card">${header}<dl>${rows}</dl></div>`;
}

export function buildForeignKeyCardAiRequest(options: {
  table: string;
  columns: readonly Pick<ColumnInfo, "name" | "data_type" | "comment">[];
  relations?: readonly { column: string; table: string; columns: readonly Pick<ColumnInfo, "name" | "data_type" | "comment">[] }[];
  instruction?: string;
  currentHtml?: string;
  language: string;
}): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    "You design compact HTML info cards that preview one database row inside a desktop database client popup (about 320px wide).",
    "Output ONLY the HTML fragment: no markdown fences, no explanations.",
    "Rules:",
    '- Insert row values with {{column_name}} placeholders using the exact column names given. Values are HTML-escaped automatically; use them in text or in attributes such as <img src="{{avatar}}">.',
    "- Columns of related tables are reached through the foreign key column with a dot: {{fk_column.related_column}} (e.g. {{department_id.name}}). Use them when they make the card more useful than a raw id.",
    "- Put CSS in one <style> block at the top; it is scoped to the card (Shadow DOM). Do not style html/body.",
    "- Use the theme CSS variables so the card works in light and dark mode: var(--foreground), var(--muted-foreground), var(--muted), var(--border), var(--primary), var(--card).",
    "- No <script>, no event handler attributes, no forms, no external fonts or stylesheets.",
    "- Pick the 3-8 most meaningful columns (identity, name, avatar/image, status, key dates); skip secrets such as password hashes and tokens.",
    "- Keep it compact and readable: a header (avatar/title) and a small key/value list is a good default.",
  ].join("\n");
  const columnLine = (column: Pick<ColumnInfo, "name" | "data_type" | "comment">, prefix = "") => `- ${prefix}${column.name} (${column.data_type})${column.comment ? `: ${column.comment}` : ""}`;
  const columnLines = options.columns.map((column) => columnLine(column)).join("\n");
  const relationLines = (options.relations ?? []).map((relation) => `Related table ${relation.table} via ${relation.column}:\n${relation.columns.map((column) => columnLine(column, `${relation.column}.`)).join("\n")}`).join("\n\n");
  const userPrompt = [
    `Table: ${options.table}`,
    "Columns:",
    columnLines,
    relationLines,
    options.currentHtml?.trim() ? `Current template (improve or adjust it):\n${options.currentHtml.trim()}` : "",
    options.instruction?.trim() ? `User request: ${options.instruction.trim()}` : "",
    `Write the card labels in this language: ${options.language}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { systemPrompt, userPrompt };
}

/** AI 偶尔仍会包一层 ```html 代码块；取出其中内容。 */
export function extractForeignKeyCardHtmlFromAi(text: string): string {
  const fenced = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(text);
  return (fenced ? fenced[1] : text).trim();
}
