import { jsonLanguage } from "@codemirror/lang-json";
import { yamlLanguage } from "@codemirror/lang-yaml";
import { xmlLanguage } from "@codemirror/lang-xml";

export type KvValueFormat = "text" | "base64" | "json" | "yaml" | "xml" | "sql" | "properties" | "shell" | "dockerfile" | "nginx" | "kubernetes";

const DOCKERFILE_INSTRUCTIONS = new Set(["ADD", "ARG", "CMD", "COPY", "ENTRYPOINT", "ENV", "EXPOSE", "FROM", "HEALTHCHECK", "LABEL", "MAINTAINER", "ONBUILD", "RUN", "SHELL", "STOPSIGNAL", "USER", "VOLUME", "WORKDIR"]);

function syntaxError(language: { parser: { parse: (text: string) => { cursor: () => { type: { isError: boolean }; next: () => boolean } } } }, text: string): boolean {
  const cursor = language.parser.parse(text).cursor();
  do {
    if (cursor.type.isError) return true;
  } while (cursor.next());
  return false;
}

export function detectKvValueFormat(text: string, encoding: "utf8" | "base64" = "utf8"): KvValueFormat {
  if (encoding === "base64") return "base64";
  const trimmed = text.trim();
  if (!trimmed) return "text";
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && !syntaxError(jsonLanguage, text)) return "json";
  if (trimmed.startsWith("<") && !syntaxError(xmlLanguage, text)) return "xml";
  if (/^#!\s*\/(?:usr\/bin\/env\s+)?(?:ba|z|k)?sh\b/m.test(text)) return "shell";
  if (/^(?:#\s*syntax=\S+\s*)?(?:FROM|ARG)\s+\S+/im.test(text)) return "dockerfile";
  if (/^\s*(?:events|http|server|upstream|location)\b[^{;]*\{/m.test(text)) return "nginx";
  if (/^\s*apiVersion\s*:\s*\S+/m.test(text) && /^\s*kind\s*:\s*\S+/m.test(text) && !syntaxError(yamlLanguage, text)) return "kubernetes";
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|GRANT|REVOKE)\b/im.test(text)) return "sql";
  if (/^(?:[#!].*\n)*\s*[A-Za-z0-9_.-]+\s*=\s*\S/m.test(text)) return "properties";
  if (/^(---\s*$|[A-Za-z0-9_.-]+\s*:)/m.test(text) && !syntaxError(yamlLanguage, text)) return "yaml";
  return "text";
}

export function validateKvValue(text: string, format: KvValueFormat): string | null {
  if (format === "json") {
    try {
      JSON.parse(text);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if ((format === "yaml" || format === "kubernetes") && syntaxError(yamlLanguage, text)) return "Invalid YAML syntax";
  if (format === "xml" && syntaxError(xmlLanguage, text)) return "Invalid XML syntax";
  if (format === "base64") {
    const normalized = text.replace(/\s+/g, "");
    if (normalized && (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0)) return "Invalid Base64 data";
  }
  if (format === "kubernetes" && text.trim()) {
    const documents = text
      .split(/^---\s*$/m)
      .map((document) => document.trim())
      .filter(Boolean);
    if (documents.some((document) => !/^\s*apiVersion\s*:\s*\S+/m.test(document) || !/^\s*kind\s*:\s*\S+/m.test(document))) {
      return "Each Kubernetes document must contain apiVersion and kind";
    }
  }
  if (format === "properties") {
    let continuing = false;
    const invalidLine = text.split(/\r?\n/).find((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return false;
      if (continuing) {
        continuing = trimmed.endsWith("\\");
        return false;
      }
      continuing = trimmed.endsWith("\\");
      return !/[=:]/.test(trimmed) && !continuing;
    });
    if (invalidLine) return `Invalid Properties entry: ${invalidLine}`;
    if (continuing) return "Invalid Properties entry: unfinished continuation";
  }
  if (format === "dockerfile") {
    let continuing = false;
    const invalidInstruction = text.split(/\r?\n/).find((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return false;
      if (continuing) {
        continuing = trimmed.endsWith("\\");
        return false;
      }
      continuing = trimmed.endsWith("\\");
      return !DOCKERFILE_INSTRUCTIONS.has(trimmed.split(/\s+/, 1)[0].toUpperCase());
    });
    if (invalidInstruction) return `Unknown Dockerfile instruction: ${invalidInstruction.split(/\s+/, 1)[0]}`;
    if (continuing) return "Invalid Dockerfile: unfinished line continuation";
  }
  if (format === "nginx") {
    let depth = 0;
    for (const character of text.replace(/#[^\r\n]*/g, "")) {
      if (character === "{") depth++;
      if (character === "}") depth--;
      if (depth < 0) return "Invalid Nginx configuration: unexpected closing brace";
    }
    if (depth !== 0) return "Invalid Nginx configuration: unbalanced braces";
  }
  return null;
}

export function formatKvValue(text: string, format: KvValueFormat): string {
  if (format === "json") return JSON.stringify(JSON.parse(text), null, 2);
  return text;
}
