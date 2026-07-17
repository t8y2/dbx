#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCALES_DIR = "apps/desktop/src/i18n/locales";
const SOURCE_LOCALE = "zh-CN";
const TARGET_LOCALES = ["en", "es", "it", "ja", "pt-BR", "zh-TW"];
const TARGET_LABELS = {
  en: "English",
  es: "Spanish",
  it: "Italian",
  ja: "Japanese",
  "pt-BR": "Brazilian Portuguese",
  "zh-TW": "Traditional Chinese used in Taiwan",
};

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || !args.has("--write");
const mockTranslations = args.has("--mock-translations") || process.env.I18N_MOCK_TRANSLATIONS === "1";
const baseRef = valueArg("--base-ref") || process.env.I18N_BASE_REF || "origin/main";
const apiKey = process.env.DEEPSEEK_API_KEY || "";
const apiUrl = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";

async function main() {
  const sourcePath = localePath(SOURCE_LOCALE);
  const baseSourceText = readBaseFile(sourcePath);
  const headSource = parseLocaleFile(readFileSync(sourcePath, "utf8"), sourcePath);
  const baseSource = parseLocaleFile(baseSourceText, `${baseRef}:${sourcePath}`);

  // Only PR-new Chinese source keys are eligible for auto-fill; historical
  // locale gaps intentionally stay untouched to keep bot patches scoped.
  const baseLeaves = flattenLeaves(baseSource.root);
  const headLeaves = flattenLeaves(headSource.root);
  const newSourceKeys = [...headLeaves.keys()].filter((key) => !baseLeaves.has(key));

  if (newSourceKeys.length === 0) {
    console.log(`No new ${SOURCE_LOCALE} i18n keys compared with ${baseRef}`);
    return;
  }

  console.log(`Found ${newSourceKeys.length} new ${SOURCE_LOCALE} i18n key(s):`);
  for (const key of newSourceKeys) console.log(`- ${key}`);

  let patchedFiles = 0;
  const summary = {
    sourceLocale: SOURCE_LOCALE,
    newKeys: newSourceKeys,
    updatedLocales: [],
  };

  for (const locale of TARGET_LOCALES) {
    const path = localePath(locale);
    if (!existsSync(path)) throw new Error(`Missing locale file: ${path}`);

    const text = readFileSync(path, "utf8");
    const parsed = parseLocaleFile(text, path);
    const targetLeaves = flattenLeaves(parsed.root);
    const missingKeys = newSourceKeys.filter((key) => !targetLeaves.has(key));

    if (missingKeys.length === 0) {
      console.log(`${locale}: all new keys already present`);
      continue;
    }

    console.log(`${locale}: missing ${missingKeys.length} new key(s)`);
    for (const key of missingKeys) console.log(`  - ${key}`);

    const translations = await translateMissing(locale, missingKeys, headLeaves);
    const updated = patchLocaleText(text, parsed, missingKeys, translations, headSource.root);

    if (updated === text) {
      throw new Error(`${path}: expected changes for missing keys, but patch was empty`);
    }

    parseLocaleFile(updated, path);
    if (!dryRun) writeFileSync(path, updated);
    patchedFiles += 1;
    summary.updatedLocales.push({ locale, count: missingKeys.length });
  }

  if (patchedFiles === 0) {
    console.log("No locale files needed changes");
  } else if (dryRun) {
    console.log(`Dry run completed; ${patchedFiles} locale file(s) would be patched`);
  } else {
    console.log(`Patched ${patchedFiles} locale file(s)`);
  }

  writeSummary(summary);
}

function valueArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function localePath(locale) {
  return join(LOCALES_DIR, `${locale}.ts`);
}

function readBaseFile(path) {
  try {
    return execFileSync("git", ["show", `${baseRef}:${path}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`Unable to read ${path} from ${baseRef}: ${error.message}`);
  }
}

function writeSummary(summary) {
  const path = process.env.I18N_SUMMARY_FILE;
  if (!path) return;
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
}

async function translateMissing(locale, keys, sourceLeaves) {
  if (mockTranslations) {
    return Object.fromEntries(keys.map((key) => [key, `[${locale}] ${sourceLeaves.get(key)}`]));
  }

  if (!apiKey) {
    throw new Error(`DEEPSEEK_API_KEY is required to translate ${keys.length} missing ${locale} i18n key(s)`);
  }

  const items = keys.map((key) => ({ key, source: sourceLeaves.get(key) }));
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: Math.max(1024, keys.length * 120),
      messages: [
        {
          role: "system",
          content: [
            `Translate DBX UI i18n strings from Simplified Chinese to ${TARGET_LABELS[locale]}.`,
            'Return strict JSON only in this exact shape: {"translations":{"path.to.key":"translated text"}}.',
            "Keep i18n placeholders such as {count}, {message}, and {name} exactly unchanged.",
            "Keep product names, database names, SQL keywords, file extensions, shortcuts, and code-like terms unchanged unless the target language convention clearly translates them.",
            "Do not add keys, remove keys, or translate key names.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({ targetLocale: locale, items }),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API failed for ${locale}: HTTP ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`DeepSeek API returned no translation content for ${locale}`);
  }

  const parsed = parseJsonContent(content);
  const translations = parsed.translations;
  if (!translations || typeof translations !== "object" || Array.isArray(translations)) {
    throw new Error(`DeepSeek response for ${locale} must contain a translations object`);
  }

  for (const key of keys) {
    if (typeof translations[key] !== "string" || !translations[key].trim()) {
      throw new Error(`DeepSeek response for ${locale} is missing translation for ${key}`);
    }
    assertSamePlaceholders(key, sourceLeaves.get(key), translations[key], locale);
  }

  return translations;
}

function parseJsonContent(content) {
  const trimmed = content.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch (error) {
    throw new Error(`Unable to parse DeepSeek JSON response: ${error.message}\n${content}`);
  }
}

function assertSamePlaceholders(key, source, translated, locale) {
  const sourcePlaceholders = placeholders(source);
  const translatedPlaceholders = placeholders(translated);
  if (sourcePlaceholders.join("\0") !== translatedPlaceholders.join("\0")) {
    throw new Error(
      `${locale}:${key} placeholder mismatch: expected [${sourcePlaceholders.join(", ")}], got [${translatedPlaceholders.join(", ")}]`,
    );
  }
}

function placeholders(value) {
  return [...String(value).matchAll(/\{[^{}]+\}/g)].map((match) => match[0]).sort();
}

function patchLocaleText(text, parsed, missingKeys, translations, sourceRoot) {
  const groups = groupMissingKeys(parsed.root, missingKeys, translations, sourceRoot);
  const edits = [];

  for (const group of groups) {
    const insertText = buildInsertion(text, group.objectNode, group.entries, group.sourceObjectNode);
    edits.push({ index: lineStartBefore(text, group.objectNode.closeBrace), text: insertText });
  }

  return applyEdits(text, edits);
}

function groupMissingKeys(targetRoot, missingKeys, translations, sourceRoot) {
  const byParent = new Map();

  for (const key of missingKeys) {
    const segments = key.split(".");
    const { node: parentNode, path: parentPath, remaining } = findInsertionParent(targetRoot, segments);
    const parentKey = parentPath.join(".");
    const sourceParent = findObjectNode(sourceRoot, parentPath);
    if (!sourceParent) throw new Error(`${key}: insertion parent is missing in ${SOURCE_LOCALE}`);

    const sourceOrder = sourceParent.properties.map((property) => property.key);
    const entry = {
      path: remaining,
      value: translations[key],
      order: sourceOrder.indexOf(remaining[0]),
    };

    if (!byParent.has(parentKey)) byParent.set(parentKey, { objectNode: parentNode, sourceObjectNode: sourceParent, entries: [] });
    byParent.get(parentKey).entries.push(entry);
  }

  return [...byParent.values()].map((group) => ({
    ...group,
    entries: group.entries.sort((left, right) => left.order - right.order || left.path.join(".").localeCompare(right.path.join("."))),
  }));
}

function findInsertionParent(root, fullPath) {
  let current = root;
  const existingPath = [];

  for (const segment of fullPath.slice(0, -1)) {
    const property = current.properties.find((candidate) => candidate.key === segment);
    if (!property) break;
    if (property.value.type !== "object") {
      throw new Error(`${fullPath.join(".")}: cannot insert under non-object locale key ${[...existingPath, segment].join(".")}`);
    }
    current = property.value;
    existingPath.push(segment);
  }

  return { node: current, path: existingPath, remaining: fullPath.slice(existingPath.length) };
}

function findObjectNode(root, path) {
  let current = root;
  for (const segment of path) {
    const property = current.properties.find((candidate) => candidate.key === segment);
    if (!property || property.value.type !== "object") return null;
    current = property.value;
  }
  return current;
}

function buildInsertion(text, objectNode, entries, sourceObjectNode) {
  const parentIndent = lineIndentBefore(text, objectNode.closeBrace);
  const childIndent = objectNode.properties.length > 0 ? lineIndentBefore(text, objectNode.properties[0].start) : `${parentIndent}  `;
  const lines = renderEntryTree(buildEntryTree(entries), sourceObjectNode, childIndent);

  return `${lines.join("\n")}\n`;
}

function buildEntryTree(entries) {
  const root = { children: new Map(), value: undefined };
  for (const entry of entries) {
    let current = root;
    for (const segment of entry.path) {
      if (!current.children.has(segment)) current.children.set(segment, { children: new Map(), value: undefined });
      current = current.children.get(segment);
    }
    current.value = entry.value;
  }
  return root;
}

function renderEntryTree(tree, sourceObjectNode, indent) {
  const lines = [];
  const entries = [...tree.children.entries()].sort(([left], [right]) => compareSourceOrder(sourceObjectNode, left, right));

  for (const [key, child] of entries) {
    if (child.children.size === 0) {
      lines.push(`${indent}${formatKey(key)}: ${JSON.stringify(child.value)},`);
      continue;
    }

    const childSourceObject = sourceObjectNode?.properties.find((property) => property.key === key && property.value.type === "object")?.value;
    lines.push(`${indent}${formatKey(key)}: {`);
    lines.push(...renderEntryTree(child, childSourceObject, `${indent}  `));
    lines.push(`${indent}},`);
  }

  return lines;
}

function compareSourceOrder(sourceObjectNode, left, right) {
  const order = sourceObjectNode?.properties.map((property) => property.key) || [];
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  }
  return left.localeCompare(right);
}

function formatKey(key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

function lineIndentBefore(text, index) {
  const lineStart = lineStartBefore(text, index);
  const match = text.slice(lineStart, index).match(/^[ \t]*/);
  return match ? match[0] : "";
}

function lineStartBefore(text, index) {
  return text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
}

function applyEdits(text, edits) {
  let updated = text;
  for (const edit of edits.sort((left, right) => right.index - left.index)) {
    updated = `${updated.slice(0, edit.index)}${edit.text}${updated.slice(edit.index)}`;
  }
  return updated;
}

function flattenLeaves(root) {
  const result = new Map();
  flattenNode(root, [], result);
  return result;
}

function flattenNode(node, path, result) {
  for (const property of node.properties) {
    const nextPath = [...path, property.key];
    if (property.value.type === "object") {
      flattenNode(property.value, nextPath, result);
    } else {
      result.set(nextPath.join("."), property.value.value);
    }
  }
}

function parseLocaleFile(text, file) {
  const parser = new Parser(text, file);
  const root = parser.parseLocaleRoot();
  return { root };
}

class Parser {
  constructor(text, file) {
    this.text = text;
    this.file = file;
    this.index = 0;
  }

  parseLocaleRoot() {
    const exportIndex = this.text.indexOf("export default");
    if (exportIndex === -1) this.fail("Missing export default");
    this.index = exportIndex + "export default".length;
    this.skipSpace();

    if (this.peek() === "{") return this.parseObject();

    const callee = this.parseIdentifier();
    this.skipSpace();
    if (!callee || this.peek() !== "(") this.fail("Expected object literal or wrapper call after export default");
    this.index += 1;
    this.skipSpace();
    const object = this.parseObject();
    this.skipSpace();
    if (this.peek() !== ")") this.fail("Expected closing wrapper call parenthesis");
    return object;
  }

  parseObject() {
    this.expect("{");
    const openBrace = this.index - 1;
    const properties = [];

    while (true) {
      this.skipSpace();
      if (this.peek() === "}") {
        const closeBrace = this.index;
        this.index += 1;
        return { type: "object", openBrace, closeBrace, end: this.index, properties };
      }

      const start = this.index;
      const key = this.parseKey();
      this.skipSpace();
      this.expect(":");
      this.skipSpace();
      const value = this.parseValue();
      this.skipSpace();

      let hasComma = false;
      if (this.peek() === ",") {
        hasComma = true;
        this.index += 1;
      }

      properties.push({ key, start, end: this.index, hasComma, value });
    }
  }

  parseValue() {
    const char = this.peek();
    if (char === "{") return this.parseObject();
    if (char === '"' || char === "'") {
      const start = this.index;
      const value = this.parseString();
      return { type: "string", start, end: this.index, value };
    }
    this.fail(`Unsupported locale value starting with ${JSON.stringify(char)}`);
  }

  parseKey() {
    const char = this.peek();
    if (char === '"' || char === "'") return this.parseString();
    const key = this.parseIdentifier();
    if (!key) this.fail("Expected property key");
    return key;
  }

  parseIdentifier() {
    const match = /^[A-Za-z_$][\w$-]*/.exec(this.text.slice(this.index));
    if (!match) return "";
    this.index += match[0].length;
    return match[0];
  }

  parseString() {
    const quote = this.peek();
    this.index += 1;
    let value = "";
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === "\\") {
        const escaped = this.text[this.index + 1];
        if (!escaped) this.fail("Unterminated string literal");
        this.index += 2;
        if (escaped === "n") value += "\n";
        else if (escaped === "r") value += "\r";
        else if (escaped === "t") value += "\t";
        else if (escaped === "b") value += "\b";
        else if (escaped === "f") value += "\f";
        else if (escaped === "v") value += "\v";
        else if (escaped === "0") value += "\0";
        else if (escaped === "u") {
          const hex = this.text.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("Invalid unicode escape");
          value += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 4;
        } else {
          value += escaped;
        }
        continue;
      }
      if (char === quote) {
        this.index += 1;
        return value;
      }
      if (char === "\n" || char === "\r") this.fail("Unterminated string literal");
      value += char;
      this.index += 1;
    }
    this.fail("Unterminated string literal");
  }

  skipSpace() {
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (/\s/.test(char)) {
        this.index += 1;
        continue;
      }
      if (this.text.startsWith("//", this.index)) {
        const next = this.text.indexOf("\n", this.index + 2);
        this.index = next === -1 ? this.text.length : next + 1;
        continue;
      }
      if (this.text.startsWith("/*", this.index)) {
        const next = this.text.indexOf("*/", this.index + 2);
        if (next === -1) this.fail("Unterminated block comment");
        this.index = next + 2;
        continue;
      }
      break;
    }
  }

  expect(expected) {
    if (this.peek() !== expected) this.fail(`Expected ${expected}`);
    this.index += expected.length;
  }

  peek() {
    return this.text[this.index] || "";
  }

  fail(message) {
    const location = this.location();
    throw new Error(`${this.file}:${location.line}:${location.column}: ${message}`);
  }

  location() {
    const before = this.text.slice(0, this.index);
    const lines = before.split(/\r?\n/);
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
