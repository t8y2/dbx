import { DEFAULT_DESCRIPTION, getHtmlLang, SITE_NAME, SITE_URL } from "./metadata";
import type { DocsLang } from "./i18n";

const localizedDescription = {
  en: DEFAULT_DESCRIPTION,
  cn: "DBX 是免费开源的数据库管理工具，支持 MySQL、PostgreSQL、SQLite、Redis 等 100+ 种数据系统，提供 SQL 编辑、AI 助手与 Docker 自托管。",
} as const;

const localizedFeatureList = {
  en: [
    "Manage 100+ SQL, NoSQL, vector, time-series, embedded databases, and message queues",
    "Desktop apps for Windows, macOS, and Linux",
    "Docker self-hosting for browser access",
    "AI-assisted SQL generation, explanation, optimization, and repair",
    "MCP Server integration for AI coding agents",
    "Schema browsing, schema diff, data editing, import, and export",
  ],
  cn: ["统一管理 100+ 种 SQL、NoSQL、向量、时序、嵌入式数据库与消息队列", "提供 Windows、macOS 与 Linux 桌面端", "支持 Docker 自托管与浏览器访问", "支持 AI 生成、解释、优化与修复 SQL", "通过 MCP Server 连接 AI 编程智能体", "提供结构浏览、结构对比、数据编辑、导入与导出"],
} as const;

export function buildSiteStructuredData() {
  return [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: SITE_NAME,
      url: SITE_URL,
      description: DEFAULT_DESCRIPTION,
      publisher: { "@id": `${SITE_URL}/#organization` },
      inLanguage: ["en", "zh-CN"],
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: SITE_NAME,
      url: SITE_URL,
      description: DEFAULT_DESCRIPTION,
      logo: `${SITE_URL}/logo.png`,
      sameAs: ["https://github.com/t8y2/dbx", "https://www.npmjs.com/package/@dbx-app/mcp-server", "https://cnb.cool/dbxio.com/dbx", "https://atomgit.com/t8y2/dbx"],
    },
  ] as const;
}

export function serializeStructuredData(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function buildDocStructuredData(lang: DocsLang, title: string, description: string, path: string) {
  const url = `${SITE_URL}${path}`;
  const docsUrl = `${SITE_URL}/${lang}/docs/what-is-dbx`;
  const labels = lang === "cn" ? ["首页", "文档"] : ["Home", "Documentation"];

  return [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "@id": `${url}#breadcrumb`,
      itemListElement: [{ "@type": "ListItem", position: 1, name: labels[0], item: `${SITE_URL}/${lang}` }, { "@type": "ListItem", position: 2, name: labels[1], item: docsUrl }, ...(url === docsUrl ? [] : [{ "@type": "ListItem", position: 3, name: title, item: url }])],
    },
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      "@id": `${url}#article`,
      url,
      mainEntityOfPage: url,
      headline: title,
      description,
      inLanguage: getHtmlLang(lang),
      isPartOf: { "@id": `${SITE_URL}/#website` },
      about: { "@id": `${SITE_URL}/#software` },
      author: { "@id": `${SITE_URL}/#organization` },
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
  ];
}

export function buildSoftwareApplicationStructuredData(lang: DocsLang, version: string) {
  const language = getHtmlLang(lang);

  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${SITE_URL}/#software`,
    name: SITE_NAME,
    url: `${SITE_URL}/${lang}`,
    description: localizedDescription[lang],
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Database management",
    operatingSystem: "Windows, macOS, Linux, Docker",
    softwareVersion: version,
    isAccessibleForFree: true,
    inLanguage: language,
    codeRepository: "https://github.com/t8y2/dbx",
    downloadUrl: "https://github.com/t8y2/dbx/releases/latest",
    releaseNotes: `${SITE_URL}/${lang}/changelog`,
    license: "https://github.com/t8y2/dbx/blob/main/LICENSE",
    screenshot: [`${SITE_URL}/screenshot-dark.png`, `${SITE_URL}/screenshot-er.png`, `${SITE_URL}/screenshot-grid.png`],
    featureList: [...localizedFeatureList[lang]],
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
    author: { "@id": `${SITE_URL}/#organization` },
    publisher: { "@id": `${SITE_URL}/#organization` },
    sameAs: ["https://github.com/t8y2/dbx", "https://www.npmjs.com/package/@dbx-app/mcp-server"],
  } as const;
}
