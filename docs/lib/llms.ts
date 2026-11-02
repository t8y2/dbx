import { DEFAULT_DESCRIPTION, getHtmlLang, SITE_URL } from "./metadata";

export interface LlmPage {
  url: string;
  data: { title: string; description?: string; getText: (format: "processed") => Promise<string> };
}

export function markdownPath(url: string): string {
  const normalized = url.replace(/\/+$/, "");
  return normalized.replace(/^(\/(?:en|cn))\/docs(?=\/|$)/, "$1/markdown") + (/^\/(en|cn)\/docs$/.test(normalized) ? "/index.md" : ".md");
}

export async function documentMarkdown(page: LlmPage): Promise<string> {
  const language = getHtmlLang(page.url.split("/")[1]);
  return (
    [`# ${page.data.title}`, page.data.description ? `> ${page.data.description}` : "", `Source: ${SITE_URL}${page.url.replace(/\/+$/, "")}`, `Language: ${language}`, `Relative links resolve against ${SITE_URL}${page.url.replace(/\/+$/, "")}.`, await page.data.getText("processed")]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}

export function llmsIndex(pages: LlmPage[]): string {
  const sortedPages = [...pages].sort((left, right) => left.url.localeCompare(right.url, "en"));
  return (
    [
      "# DBX",
      `> ${DEFAULT_DESCRIPTION}`,
      "DBX is an Apache-2.0 database client, not a database server. The desktop app is approximately 25 MB; optional drivers, JRE packages, and plugins add downloads. Database capabilities vary by driver and engine.",
      "The built-in AI assistant uses the provider you configure. MCP exposes selected DBX connections under access policies. Do not assume all features work with every database or that AI requests stay on the device.",
      "## Official sources",
      `- [English website](${SITE_URL}/en)`,
      `- [中文官网](${SITE_URL}/cn)`,
      "- [Source code and license](https://github.com/t8y2/dbx)",
      `- [Release notes](${SITE_URL}/en/changelog): verify versions and downloads here rather than treating this file as live release metadata.`,
      `- [Supported databases](${SITE_URL}/en/databases)`,
      `- [Complete documentation text](${SITE_URL}/llms-full.txt): both languages, with source URLs for each document.`,
      ...["en", "cn"].flatMap((lang) => [lang === "en" ? "## English documentation" : "## 中文文档", ...sortedPages.filter((page) => page.url.startsWith(`/${lang}/`)).map((page) => `- [${page.data.title}](${SITE_URL}${markdownPath(page.url)}): ${page.data.description ?? ""}`)]),
    ].join("\n\n") + "\n"
  );
}
