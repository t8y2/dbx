import { DEFAULT_DESCRIPTION, SITE_NAME, SITE_URL } from "./metadata";

const localizedDescription = {
  en: DEFAULT_DESCRIPTION,
  cn: "70+ 种数据库，仅 20 MB。支持桌面端、Docker 自托管、AI 助手与 MCP Server。",
} as const;

const localizedFeatureList = {
  en: [
    "Manage 70+ SQL, NoSQL, vector, time-series, embedded databases, and message queues",
    "Desktop apps for Windows, macOS, and Linux",
    "Docker self-hosting for browser access",
    "AI-assisted SQL generation, explanation, optimization, and repair",
    "MCP Server integration for AI coding agents",
    "Schema browsing, schema diff, data editing, import, and export",
  ],
  cn: [
    "统一管理 70+ 种 SQL、NoSQL、向量、时序、嵌入式数据库与消息队列",
    "提供 Windows、macOS 与 Linux 桌面端",
    "支持 Docker 自托管与浏览器访问",
    "支持 AI 生成、解释、优化与修复 SQL",
    "通过 MCP Server 连接 AI 编程智能体",
    "提供结构浏览、结构对比、数据编辑、导入与导出",
  ],
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
      sameAs: [
        "https://github.com/t8y2/dbx",
        "https://www.npmjs.com/package/@dbx-app/mcp-server",
        "https://cnb.cool/dbxio.com/dbx",
        "https://atomgit.com/t8y2/dbx",
      ],
    },
  ] as const;
}

export function buildSoftwareApplicationStructuredData(lang: "en" | "cn", version: string) {
  const language = lang === "cn" ? "zh-CN" : "en";

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
    screenshot: [
      `${SITE_URL}/screenshot-dark.png`,
      `${SITE_URL}/screenshot-er.png`,
      `${SITE_URL}/screenshot-grid.png`,
    ],
    featureList: [...localizedFeatureList[lang]],
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
    author: { "@id": `${SITE_URL}/#organization` },
    publisher: { "@id": `${SITE_URL}/#organization` },
    sameAs: [
      "https://github.com/t8y2/dbx",
      "https://www.npmjs.com/package/@dbx-app/mcp-server",
    ],
  } as const;
}
