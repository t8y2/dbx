import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

export function normalizeNacosConfigFormat(value?: string): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "txt") return "text";
  if (normalized === "yml") return "yaml";
  if (normalized === "props") return "properties";
  return normalized;
}

export function inferNacosConfigFormat(dataId?: string): string {
  const ext = dataId?.trim().toLowerCase().split(".").pop() || "";
  if (ext === "yml") return "yaml";
  if (["yaml", "json", "xml", "html", "properties", "toml", "text"].includes(ext)) return ext;
  if (ext === "txt") return "text";
  return "";
}

export function resolveNacosConfigFormat(configType?: string, dataId?: string): string {
  return normalizeNacosConfigFormat(configType) || inferNacosConfigFormat(dataId) || "text";
}

export async function loadNacosConfigLanguage(format: string): Promise<Extension[]> {
  switch (normalizeNacosConfigFormat(format)) {
    case "json": {
      const { json } = await import("@codemirror/lang-json");
      return [json()];
    }
    case "yaml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return [yaml()];
    }
    case "xml": {
      const { xml } = await import("@codemirror/lang-xml");
      return [xml()];
    }
    case "html": {
      const { html } = await import("@codemirror/lang-html");
      return [html({ matchClosingTags: false })];
    }
    case "properties": {
      const { properties } = await import("@codemirror/legacy-modes/mode/properties");
      return [StreamLanguage.define(properties)];
    }
    case "toml": {
      const { toml } = await import("@codemirror/legacy-modes/mode/toml");
      return [StreamLanguage.define(toml)];
    }
    default:
      return [];
  }
}
