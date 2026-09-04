import { htmlLanguage } from "@codemirror/lang-html";
import { jsonLanguage } from "@codemirror/lang-json";
import { XMLValidator } from "fast-xml-parser";
import { parse as parseToml, TomlError } from "smol-toml";
import { parseDocument } from "yaml";

export type NacosConfigValidationFormat = "text" | "json" | "xml" | "yaml" | "html" | "properties" | "toml";

export interface NacosConfigDiagnostic {
  message: string;
  line: number;
  column: number;
  from: number;
  to: number;
}

function lineColumnAt(text: string, offset: number) {
  const bounded = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, bounded);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: bounded - lineStart + 1 };
}

function diagnosticAt(text: string, offset: number, message: string, length = 1): NacosConfigDiagnostic {
  const position = lineColumnAt(text, offset);
  return { message, ...position, from: offset, to: Math.min(text.length, Math.max(offset + length, offset + 1)) };
}

function offsetAtLineColumn(text: string, line: number, column: number): number {
  let offset = 0;
  for (let currentLine = 1; currentLine < line && offset < text.length; currentLine += 1) {
    const newline = text.indexOf("\n", offset);
    offset = newline < 0 ? text.length : newline + 1;
  }
  return Math.min(text.length, offset + Math.max(0, column - 1));
}

type SyntaxErrorRange = { from: number; to: number };
type HtmlOpenTag = { name: string; offset: number };

const HTML_VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const HTML_OPTIONAL_END_TAGS = new Set(["html", "head", "body", "colgroup", "li", "dt", "dd", "p", "rt", "rp", "optgroup", "option", "thead", "tbody", "tfoot", "tr", "td", "th"]);
const HTML_RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
const HTML_BLOCK_TAGS_THAT_CLOSE_P = new Set(["address", "article", "aside", "blockquote", "div", "dl", "fieldset", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul"]);

function syntaxErrors(text: string, language: { parser: { parse: (source: string) => { iterate: (spec: { enter: (node: { type: { isError: boolean }; from: number; to: number }) => void }) => void } } }): SyntaxErrorRange[] {
  const errors: SyntaxErrorRange[] = [];
  language.parser.parse(text).iterate({
    enter(node) {
      if (node.type.isError) errors.push({ from: node.from, to: node.to });
    },
  });
  return errors.filter((error, index) => errors.findIndex((candidate) => candidate.from === error.from && candidate.to === error.to) === index);
}

function firstSyntaxError(text: string, language: { parser: { parse: (source: string) => { iterate: (spec: { enter: (node: { type: { isError: boolean }; from: number; to: number }) => void }) => void } } }, label: string) {
  const error = syntaxErrors(text, language)[0];
  return error ? diagnosticAt(text, error.from, `Invalid ${label} syntax`, Math.max(1, error.to - error.from)) : null;
}

function htmlTagEnd(text: string, start: number): number {
  let quote = "";
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function closeImplicitHtmlTags(stack: HtmlOpenTag[], openingTag: string) {
  const current = stack[stack.length - 1]?.name;
  if (!current) return;
  if (openingTag === "li" && current === "li") stack.pop();
  else if (["dt", "dd"].includes(openingTag) && ["dt", "dd"].includes(current)) stack.pop();
  else if (openingTag === "option" && current === "option") stack.pop();
  else if (openingTag === "optgroup" && ["option", "optgroup"].includes(current)) stack.pop();
  else if (["thead", "tbody", "tfoot"].includes(openingTag) && ["thead", "tbody", "tfoot"].includes(current)) stack.pop();
  else if (openingTag === "tr" && current === "tr") stack.pop();
  else if (["td", "th"].includes(openingTag) && ["td", "th"].includes(current)) stack.pop();
  else if (current === "p" && HTML_BLOCK_TAGS_THAT_CLOSE_P.has(openingTag)) stack.pop();
}

function validateHtml(text: string): NacosConfigDiagnostic | null {
  const syntaxError = firstSyntaxError(text, htmlLanguage, "HTML");
  if (syntaxError) return syntaxError;

  const stack: HtmlOpenTag[] = [];
  for (let offset = 0; offset < text.length; ) {
    if (text[offset] !== "<") {
      offset += 1;
      continue;
    }
    if (text.startsWith("<!--", offset)) {
      const end = text.indexOf("-->", offset + 4);
      if (end < 0) return diagnosticAt(text, offset, "Invalid HTML syntax: unclosed comment");
      offset = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", offset)) {
      const end = text.indexOf("]]>", offset + 9);
      if (end < 0) return diagnosticAt(text, offset, "Invalid HTML syntax: unclosed CDATA section");
      offset = end + 3;
      continue;
    }
    if (text[offset + 1] === "!" || text[offset + 1] === "?") {
      const end = htmlTagEnd(text, offset + 2);
      if (end < 0) return diagnosticAt(text, offset, "Invalid HTML syntax: unclosed declaration");
      offset = end + 1;
      continue;
    }

    const closing = text[offset + 1] === "/";
    const nameStart = offset + (closing ? 2 : 1);
    const name = /^[A-Za-z][A-Za-z0-9:_-]*/.exec(text.slice(nameStart))?.[0]?.toLowerCase();
    if (!name) {
      offset += 1;
      continue;
    }
    const end = htmlTagEnd(text, nameStart + name.length);
    if (end < 0) return diagnosticAt(text, offset, "Invalid HTML syntax: unclosed tag");
    const selfClosing = /\/\s*$/.test(text.slice(nameStart + name.length, end));
    offset = end + 1;

    if (closing) {
      while (stack.length && stack[stack.length - 1]?.name !== name && HTML_OPTIONAL_END_TAGS.has(stack[stack.length - 1]?.name || "")) stack.pop();
      const openTag = stack[stack.length - 1];
      if (!openTag) return diagnosticAt(text, nameStart, `Invalid HTML syntax: closing tag '${name}' has not been opened`, name.length);
      if (openTag.name !== name) return diagnosticAt(text, nameStart, `Invalid HTML syntax: expected closing tag '${openTag.name}'`, name.length);
      stack.pop();
      continue;
    }

    closeImplicitHtmlTags(stack, name);
    if (!selfClosing && !HTML_VOID_TAGS.has(name)) stack.push({ name, offset });
    if (HTML_RAW_TEXT_TAGS.has(name)) {
      const closingTag = new RegExp(`</${name}\\s*>`, "i");
      const match = closingTag.exec(text.slice(offset));
      if (!match || match.index === undefined) return diagnosticAt(text, offset - 1, `Invalid HTML syntax: unclosed tag '${name}'`, name.length);
      offset += match.index;
    }
  }

  const unclosed = [...stack].reverse().find((tag) => !HTML_OPTIONAL_END_TAGS.has(tag.name));
  return unclosed ? diagnosticAt(text, unclosed.offset, `Invalid HTML syntax: unclosed tag '${unclosed.name}'`, unclosed.name.length) : null;
}

function jsonErrorOffset(text: string, error: SyntaxErrorRange): number {
  if (error.to > error.from) return error.from;
  const previous = previousNonWhitespaceOffset(text, error.from);
  const next = nextNonWhitespaceOffset(text, error.from);
  if (previous >= 0 && text[previous] === "," && next < text.length && (text[next] === "}" || text[next] === "]")) return previous;
  if (previous >= 0 && (next >= text.length || "{[}]".includes(text[next]))) return previous;
  return next < text.length ? next : Math.max(0, previous);
}

function trailingCommaOffset(text: string, offset: number): number | null {
  const previous = previousNonWhitespaceOffset(text, offset);
  const next = nextNonWhitespaceOffset(text, offset);
  return previous >= 0 && text[previous] === "," && next < text.length && (text[next] === "}" || text[next] === "]") ? previous : null;
}

function validateJson(text: string): NacosConfigDiagnostic[] {
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errors = syntaxErrors(text, jsonLanguage);
    if (errors.length) {
      return errors.map((syntaxError, index) => {
        const offset = jsonErrorOffset(text, syntaxError);
        const trailingComma = trailingCommaOffset(text, syntaxError.from) ?? trailingCommaOffset(text, offset);
        if (trailingComma !== null) return diagnosticAt(text, trailingComma, "Trailing comma is not allowed in JSON");
        return diagnosticAt(text, offset, index === 0 ? message : "Invalid JSON syntax", Math.max(1, syntaxError.to - syntaxError.from));
      });
    }
    const match = /position\s+(\d+)/i.exec(message);
    return [diagnosticAt(text, match ? Number(match[1]) : 0, message)];
  }
}

function previousNonWhitespaceOffset(text: string, offset: number): number {
  let index = Math.min(offset, text.length) - 1;
  while (index >= 0 && /\s/.test(text[index])) index--;
  return index;
}

function nextNonWhitespaceOffset(text: string, offset: number): number {
  let index = Math.max(0, offset);
  while (index < text.length && /\s/.test(text[index])) index++;
  return index;
}

function validateYaml(text: string): NacosConfigDiagnostic | null {
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (const line of lines) {
    const indentation = /^[ \t]*/.exec(line)?.[0] ?? "";
    const tabIndex = indentation.indexOf("\t");
    if (tabIndex >= 0) {
      return diagnosticAt(text, offset + tabIndex, "YAML indentation must use spaces, not tabs");
    }
    offset += line.length + 1;
  }
  const document = parseDocument(text);
  const error = document.errors[0];
  if (error) {
    const offsetFromError = Array.isArray(error.pos) ? error.pos[0] : 0;
    return diagnosticAt(text, offsetFromError, error.message);
  }
  return null;
}

function validateXml(text: string): NacosConfigDiagnostic | null {
  const result = XMLValidator.validate(text);
  if (result === true) return null;
  const { err } = result;
  return diagnosticAt(text, offsetAtLineColumn(text, err.line, err.col), `Invalid XML syntax: ${err.msg}`);
}

function validateProperties(text: string): NacosConfigDiagnostic | null {
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] !== "\\") continue;
    if (text[offset + 1] !== "u") {
      offset += 1;
      continue;
    }
    const unicode = text.slice(offset + 2, offset + 6);
    if (!/^[0-9a-f]{4}$/i.test(unicode)) {
      return diagnosticAt(text, offset, "Invalid Properties Unicode escape", Math.min(6, text.length - offset));
    }
    offset += 5;
  }
  return null;
}

function validateToml(text: string): NacosConfigDiagnostic | null {
  try {
    parseToml(text);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n\n", 1)[0] : String(error);
    const position = error instanceof TomlError ? offsetAtLineColumn(text, error.line, error.column) : 0;
    return diagnosticAt(text, position, `Invalid TOML syntax: ${message}`);
  }
}

export function validateNacosConfigContent(text: string, format: string): NacosConfigDiagnostic[] {
  const rawFormat = format.trim().toLowerCase();
  const normalized = (rawFormat === "yml" ? "yaml" : rawFormat === "props" ? "properties" : rawFormat) as NacosConfigValidationFormat;
  let diagnostic: NacosConfigDiagnostic | null = null;
  if (normalized === "json") return validateJson(text);
  else if (normalized === "yaml") diagnostic = validateYaml(text);
  else if (normalized === "xml") diagnostic = validateXml(text);
  else if (normalized === "html") diagnostic = validateHtml(text);
  else if (normalized === "properties") diagnostic = validateProperties(text);
  else if (normalized === "toml") diagnostic = validateToml(text);
  return diagnostic ? [diagnostic] : [];
}

export function validateNacosConfig(text: string, format: string): NacosConfigDiagnostic | null {
  return validateNacosConfigContent(text, format)[0] ?? null;
}
