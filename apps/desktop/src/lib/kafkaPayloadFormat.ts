import { decode as decodeMsgPack } from "@msgpack/msgpack";

export type KafkaPayloadFormat = "raw" | "json" | "xml" | "hex" | "msgpack" | "yml";

export const KAFKA_PAYLOAD_FORMATS: Array<{ id: KafkaPayloadFormat; label: string }> = [
  { id: "raw", label: "RAW" },
  { id: "json", label: "JSON" },
  { id: "xml", label: "XML" },
  { id: "hex", label: "HEX" },
  { id: "msgpack", label: "MsgPack" },
  { id: "yml", label: "YML" },
];

function payloadBytes(text: string, encoding?: string): Uint8Array {
  if (encoding === "base64") {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  return new TextEncoder().encode(text);
}

function formatJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

function formatXml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<")) return text;
  const compact = trimmed.replace(/>\s+</g, "><");
  let formatted = "";
  let indent = 0;
  const parts = compact.replace(/></g, ">\n<").split("\n");
  for (const part of parts) {
    const line = part.trim();
    if (!line) continue;
    if (line.startsWith("</")) indent = Math.max(0, indent - 1);
    formatted += `${"  ".repeat(indent)}${line}\n`;
    if (line.startsWith("<") && !line.startsWith("</") && !line.endsWith("/>") && !line.includes("</")) {
      indent += 1;
    }
  }
  return formatted.trimEnd();
}

function formatHex(text: string, encoding?: string): string {
  const bytes = payloadBytes(text, encoding);
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 16) {
    const slice = bytes.slice(index, index + 16);
    const hex = Array.from(slice, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(slice, (byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".")).join("");
    chunks.push(`${index.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`);
  }
  return chunks.join("\n");
}

function formatMsgPack(text: string, encoding?: string): string {
  try {
    const decoded = decodeMsgPack(payloadBytes(text, encoding));
    return JSON.stringify(decoded, null, 2);
  } catch {
    return text;
  }
}

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    if (value === "" || /[:#{}[\],&*!|>'"%@`]|^\s|\s$/.test(value)) return JSON.stringify(value);
    return value;
  }
  return JSON.stringify(value);
}

function jsonToYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        if (item && typeof item === "object") {
          const nested = jsonToYaml(item, indent + 1).trimStart();
          return `${pad}- ${nested.startsWith("\n") ? `\n${"  ".repeat(indent + 1)}${nested.trimStart()}` : nested}`;
        }
        return `${pad}- ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, item]) => {
        if (item && typeof item === "object") {
          const nested = jsonToYaml(item, indent + 1);
          return `${pad}${key}:\n${nested}`;
        }
        return `${pad}${key}: ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  return yamlScalar(value);
}

function formatYaml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try {
    return jsonToYaml(JSON.parse(trimmed));
  } catch {
    return text;
  }
}

export function formatKafkaPayloadText(text: string, format: KafkaPayloadFormat, encoding?: string): string {
  if (!text) return "";
  switch (format) {
    case "json":
      return formatJson(text);
    case "xml":
      return formatXml(text);
    case "hex":
      return formatHex(text, encoding);
    case "msgpack":
      return formatMsgPack(text, encoding);
    case "yml":
      return formatYaml(text);
    case "raw":
    default:
      return text;
  }
}

export interface HighlightSegment {
  text: string;
  highlighted: boolean;
}

export function highlightSearchText(text: string, query: string): HighlightSegment[] {
  const needle = query.trim();
  if (!needle) return [{ text, highlighted: false }];
  const lower = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const segments: HighlightSegment[] = [];
  let start = 0;
  let index = lower.indexOf(lowerNeedle, start);
  while (index !== -1) {
    if (index > start) segments.push({ text: text.slice(start, index), highlighted: false });
    segments.push({ text: text.slice(index, index + needle.length), highlighted: true });
    start = index + needle.length;
    index = lower.indexOf(lowerNeedle, start);
  }
  if (start < text.length) segments.push({ text: text.slice(start), highlighted: false });
  return segments.length > 0 ? segments : [{ text, highlighted: false }];
}

export function kafkaMessageMatchesQuery(parts: string[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = parts.join("\n").toLowerCase();
  return haystack.includes(needle);
}
