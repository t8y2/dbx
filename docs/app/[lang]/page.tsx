import Link from "next/link";
import type { Metadata } from "next";
import { HeroProductStage } from "@/components/aceternity/HeroProductStage";
import { InfiniteMovingCards } from "@/components/aceternity/InfiniteMovingCards";
import { Spotlight } from "@/components/aceternity/Spotlight";
import { Starfield } from "@/components/landing/Starfield";
import { LandingNav } from "@/components/landing/LandingNav";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { InstallTabs } from "@/components/landing/InstallTabs";
import { RevealSection } from "@/components/landing/RevealSection";
import { ContributorsWallContent } from "@/components/landing/ContributorsWall";
import { DatabasePillMarquee } from "@/components/landing/DatabasePillMarquee";
import contributorSnapshot from "@/data/contributors.json";
import { databaseSupport } from "@/data/databaseSupport";
import type { ContributorActivityData } from "@/lib/contributorActivity";
import { contributorsFromActivity } from "@/lib/contributors";
import { getAppVersion } from "@/lib/appVersion";
import { fetchLatestReleaseInfo } from "@/lib/latestRelease";
import { buildMetadata, getHtmlLang } from "@/lib/metadata";
import { buildSoftwareApplicationStructuredData } from "@/lib/structuredData";
import { ArrowRight, Bot, Database, FileCode, GitCompare, Network, Search, Shield, Table, Terminal, Zap } from "lucide-react";
import { resolveLang, type DocsLang } from "@/lib/i18n";

function formatStars(count: number) {
  if (count >= 1000) {
    return `${(Math.floor(count / 100) / 10).toFixed(1)}k+`;
  }

  return `${count}+`;
}

function metrics(starLabel: string) {
  return {
    en: [
      { value: "~25 MB", label: "desktop installer" },
      { value: "90+", label: "database engines" },
      { value: "2 modes", label: "desktop and Docker" },
      { value: starLabel, label: "GitHub stars, fully open-source" },
    ],
    cn: [
      { value: "~25 MB", label: "桌面安装包" },
      { value: "90+", label: "数据库引擎" },
      { value: "2 种模式", label: "桌面与 Docker" },
      { value: starLabel, label: "GitHub Star，完全开源" },
    ],
  };
}

const workflows = {
  en: [
    {
      icon: Terminal,
      title: "Write and run SQL",
      desc: "A CodeMirror 6 editor with metadata-aware completion, formatting, history, and selected SQL execution.",
      href: "/en/docs/query-editor",
    },
    {
      icon: Table,
      title: "Browse and edit data",
      desc: "Virtualized grids, inline editing, WHERE/ORDER BY controls, SQL preview, and export tools.",
      href: "/en/docs/data-grid",
    },
    {
      icon: Search,
      title: "Explore schemas",
      desc: "Navigate databases, schemas, tables, columns, indexes, foreign keys, and triggers from a focused sidebar.",
      href: "/en/docs/schema-browser",
    },
    {
      icon: GitCompare,
      title: "Compare and migrate",
      desc: "Schema diff, table import, database export, SQL file execution, and cross-engine data transfer.",
      href: "/en/docs/schema-diff",
    },
  ],
  cn: [
    {
      icon: Terminal,
      title: "编写与执行 SQL",
      desc: "CodeMirror 6 编辑器，支持元数据补全、格式化、查询历史和选中 SQL 执行。",
      href: "/cn/docs/query-editor",
    },
    {
      icon: Table,
      title: "浏览与编辑数据",
      desc: "虚拟滚动表格、行内编辑、WHERE/ORDER BY 控制、SQL 预览和导出工具。",
      href: "/cn/docs/data-grid",
    },
    {
      icon: Search,
      title: "浏览数据库结构",
      desc: "在侧边栏中查看数据库、Schema、表、字段、索引、外键和触发器。",
      href: "/cn/docs/schema-browser",
    },
    {
      icon: GitCompare,
      title: "对比与迁移",
      desc: "Schema 对比、表导入、数据库导出、SQL 文件执行和跨引擎数据传输。",
      href: "/cn/docs/schema-diff",
    },
  ],
};

const capabilities = {
  en: [
    { icon: Database, label: "Native Rust drivers, no JDBC runtime" },
    { icon: Shield, label: "SSH tunnels, encrypted config export, destructive action guards" },
    { icon: Bot, label: "AI assistant plus MCP server for Claude Code, Cursor, and agents" },
    { icon: Network, label: "ER diagrams, schema diff, and field lineage for deeper analysis" },
    { icon: FileCode, label: "CSV, Excel, SQL files, full exports, and cross-engine transfer" },
    { icon: Zap, label: "Desktop app and self-hosted web deployment from the same project" },
  ],
  cn: [
    { icon: Database, label: "Rust 原生驱动，不依赖 JDBC 运行时" },
    { icon: Shield, label: "SSH 隧道、加密配置导出、危险操作确认" },
    { icon: Bot, label: "内置 AI 助手，以及面向 Claude Code、Cursor 的 MCP Server" },
    { icon: Network, label: "ER 图、Schema 对比、字段血缘，覆盖更深层分析场景" },
    { icon: FileCode, label: "CSV、Excel、SQL 文件、完整导出和跨引擎传输" },
    { icon: Zap, label: "桌面应用与自托管 Web 部署来自同一个项目" },
  ],
};

const testimonials = {
  en: [
    {
      name: "eryajf",
      role: "Database management",
      avatar: "/avatars/eryajf.jpg",
      quote: "Try it once and you can feel it: DBX is the database management client that ends the competition.",
    },
    {
      name: "Better Stack",
      role: "YouTube review · Sep 2026",
      avatar: "/avatars/betterstack.png",
      quote: "DBX is almost the perfect free database client.",
    },
    {
      name: "Hysen Labs",
      role: "Editorial review · Aug 2026",
      avatar: "/avatars/hysenlabs.png",
      quote: "Adopt dbx if you need a lightweight, cross-platform client that covers many databases.",
    },
    {
      name: "HelloGitHub",
      role: "Featured in issue #122 · rated 10.0",
      avatar: "/avatars/hellogithub.png",
      quote: "A lightweight, cross-platform, offline-capable database desktop client that supports over 40 databases.",
    },
    {
      name: "Xiaoz",
      role: "xiaoz.org blog · May 2026",
      avatar: "/avatars/xiaoz.jpg",
      quote: "If you are tired of Navicat's expensive licensing and DBeaver's heaviness, try DBX, a powerful open-source tool under 20MB.",
    },
    {
      name: "Niaoge (@NFTCPS)",
      role: "X post · Aug 2026 · translated",
      avatar: "/avatars/nftcps.jpg",
      quote: "An open-source tool that's only 20MB, yet it packs in 80+ databases — MySQL, PostgreSQL, Redis, MongoDB, Oracle, ClickHouse, and Dameng all connect.",
    },
    {
      name: "Hardy",
      role: "Juejin post · Sep 2026 · translated",
      avatar: "/avatars/hardy.jpg",
      quote: "DBX's real value may not be rebuilding DBeaver, but rethinking what a database tool should look like in the AI era.",
    },
    {
      name: "Programmer Xiaofan",
      role: "cnblogs · Jun 2026 · translated",
      avatar: "/avatars/xiezhr.png",
      quote: "It genuinely works, and it feels smooth in daily use. This AI-powered database management tool is really worth a try.",
    },
    {
      name: "Chimin",
      role: "Medium · May 2026",
      avatar: "/avatars/chimin.jpg",
      quote: "The 15 MB figure isn't hype. Tauri 2 doesn't embed Chromium; it directly calls the system's WebView — this alone saves over 100 MB compared to Electron.",
    },
    {
      name: "Trendshift",
      role: "GitHub Trending #2 · Aug 2026",
      avatar: "/avatars/trendshift.png",
      quote: "Reached #2 on GitHub Trending, with Repository of the Day, Week, and Month badges on Trendshift.",
    },
    {
      name: "Hysen Labs",
      role: "Editorial review · Aug 2026",
      avatar: "/avatars/hysenlabs.png",
      quote: "The editor's metadata-aware autocomplete is a differentiator, and the built-in MCP server is a unique advantage.",
    },
    {
      name: "Niaoge (@NFTCPS)",
      role: "X post · Aug 2026 · translated",
      avatar: "/avatars/nftcps.jpg",
      quote: "An AI SQL assistant that writes, explains, optimizes, and fixes SQL, plus native MCP Server support — Cursor and Claude Code can query your database directly.",
    },
    {
      name: "東方幽静響",
      role: "Zhihu · Jun 2026 · translated",
      avatar: "/avatars/zhihu_dongfang.jpg",
      quote: "A 15MB package that packs in 40+ databases, AI assistance, and full database management — that alone is a cool thing.",
    },
    {
      name: "Java陈序员",
      role: "Zhihu · Jun 2026 · translated",
      avatar: "/avatars/zhihu_chenxuyuan.jpg",
      quote: "A lightweight yet all-in-one database management tool, supporting dozens of databases with built-in AI.",
    },
    {
      name: "GoLang学习记",
      role: "Tencent Cloud community · Jun 2026 · translated",
      avatar: "/avatars/golangxuexiji.jpg",
      quote: "It doesn't have every DBeaver feature, but everything it has is done well. The AI assistant isn't a gimmick — it's genuinely useful.",
    },
    {
      name: "Xiaoz",
      role: "xiaoz.org blog · May 2026",
      avatar: "/avatars/xiaoz.jpg",
      quote: "Is Navicat too expensive or DBeaver too heavy? Xiaoz has finally found it: DBX.",
    },
    {
      name: "GoLang学习记",
      role: "Tencent Cloud community · Jun 2026 · translated",
      avatar: "/avatars/golangxuexiji.jpg",
      quote: "So fast you forget it's a database tool. Like air — present, but never in the way.",
    },
    {
      name: "linux.do community",
      role: "linux.do · Jul 2026 · translated",
      avatar: "/avatars/linuxdo.png",
      quote: "Free and open source, zero setup — download and run. It may not match DBeaver feature-for-feature, but it's simple and smooth.",
    },
  ],
  cn: [
    {
      name: "二丫讲梵",
      role: "数据库管理",
      avatar: "/avatars/eryajf.jpg",
      quote: "只需体验一次你就能感受到，DBX是一个杀死数据库管理客户端比赛的软件",
    },
    {
      name: "鸟哥 | 蓝鸟会",
      role: "X（Twitter）· 2026-08",
      avatar: "/avatars/nftcps.jpg",
      quote: "发现个开源工具 DBX，整个才 20MB，却塞进了 80 多种数据库，MySQL、PostgreSQL、Redis、MongoDB、Oracle、ClickHouse、达梦全都能连。",
    },
    {
      name: "程序员晓凡",
      role: "博客园 · 2026-06",
      avatar: "/avatars/xiezhr.png",
      quote: "它是真能用，而且用起来还特顺手。dbx这搭载AI功能的数据库管理工具，真的值得试试。",
    },
    {
      name: "xiaoz",
      role: "xiaoz 博客 · 2026-05",
      avatar: "/avatars/xiaoz.jpg",
      quote: "如果你受够了Navicat的昂贵授权和DBeaver的笨重，不妨试试DBX这款不到20MB的开源利器。",
    },
    {
      name: "架构师部落",
      role: "腾讯云开发者社区 · 2026-06",
      avatar: "/avatars/jianzhishi.jpg",
      quote: "无论是初学数据库的新手，还是常年和数据打交道的后端、运维工程师，都值得收入工具箱。",
    },
    {
      name: "前端Hardy",
      role: "掘金 · 2026-09",
      avatar: "/avatars/hardy.jpg",
      quote: "而这可能才是 DBX 真正的价值：不是再造一个 DBeaver，而是重新思考 AI 时代「数据库工具到底应该长什么样」。",
    },
    {
      name: "HelloGitHub",
      role: "第 122 期收录 · 社区评分 10.0",
      avatar: "/avatars/hellogithub.png",
      quote: "轻量级、跨平台、可离线使用的数据库桌面客户端，支持 MySQL、PostgreSQL、SQLite、Redis、MongoDB 等 40+ 种数据库。",
    },
    {
      name: "X-CMD",
      role: "软件收录 · 2026",
      avatar: "/avatars/xcmd.png",
      quote: "把「数据库客户端」重新定义为「统一 + AI + MCP」，而不是又一个 GUI 包装器。",
    },
    {
      name: "東方幽静響",
      role: "知乎 · 2026-06",
      avatar: "/avatars/zhihu_dongfang.jpg",
      quote: "15MB 的体积，却塞进了 40+ 种数据库的支持、AI 辅助和完整的数据库管理功能，这本身就是一件很酷的事情。",
    },
    {
      name: "Java陈序员",
      role: "知乎 · 2026-06",
      avatar: "/avatars/zhihu_chenxuyuan.jpg",
      quote: "今天，给大家分享一款轻量又全能的数据库管理工具，支持数十种数据库，还内置 AI 能力！",
    },
    {
      name: "GoLang学习记",
      role: "腾讯云开发者社区 · 2026-06",
      avatar: "/avatars/golangxuexiji.jpg",
      quote: "它没有 DBeaver 的所有功能。但它有的功能，都做得很好。AI 助手不是噱头，是真的有用。",
    },
    {
      name: "OSCHINA 开源中国",
      role: "开源项目收录 · 国内精选",
      avatar: "/avatars/oschina.png",
      quote: "一个开源数据库工作台，把日常数据库工作里的高频动作放在同一个界面里。",
    },
    {
      name: "linux.do 社区",
      role: "linux.do · 2026-04",
      avatar: "/avatars/linuxdo.png",
      quote: "使用了一段时间感觉真的很好用，功能齐全，几乎支持所有数据库，可以丢掉其它数据库软件了。",
    },
    {
      name: "xiaoz",
      role: "xiaoz 博客 · 2026-05",
      avatar: "/avatars/xiaoz.jpg",
      quote: "Navicat 太贵、DBeaver 太重？免费、轻量还支持多种数据库的客户端，这次终于被 xiaoz 找到了。",
    },
    {
      name: "鸟哥 | 蓝鸟会",
      role: "X（Twitter）· 2026-08",
      avatar: "/avatars/nftcps.jpg",
      quote: "自带 AI SQL 助手，写不出来的 SQL 让它生成、解释、优化、修 bug；原生支持 MCP Server，Cursor、Claude Code 能直接连你的库查数据。",
    },
    {
      name: "架构师部落",
      role: "腾讯云开发者社区 · 2026-06",
      avatar: "/avatars/jianzhishi.jpg",
      quote: "轻量化优势拉满，低配电脑、办公本也能流畅运行。DBX 用 15MB 的小巧身躯，包揽了数据库管理的全流程需求。",
    },
    {
      name: "GoLang学习记",
      role: "腾讯云开发者社区 · 2026-06",
      avatar: "/avatars/golangxuexiji.jpg",
      quote: "快到让你忘记它是一个数据库管理工具。就像空气一样，存在但不打扰。",
    },
    {
      name: "linux.do 社区",
      role: "linux.do · 2026-07",
      avatar: "/avatars/linuxdo.png",
      quote: "开源免费，不需要折腾环境，下载就能用，虽然功能没有 DBeaver 那么多，但是简单顺手。",
    },
  ],
};

const METRICS_LABEL: Record<DocsLang, string> = {
  en: "DBX key metrics",
  cn: "DBX 核心指标",
};

const localizedTestimonials = testimonials;

const i18nText = {
  en: {
    heroTitle: "25 MB to manage 90+ databases!",
    heroSubtitle: "DBX brings connections, SQL editing, data grids, schema tools, AI assistance, and self-hosted access into one lightweight product.",
    download: "Download DBX",
    downloadName: "Download DBX",
    readDocs: "Read the docs",
    docsStart: "Start here",
    docsStartDesc: "Install DBX, create your first connection, and learn the main workflow.",
    workflowsTitle: "Core workflows",
    workflowsDesc: "The docs are organized around what you actually do in a database client.",
    supportTitle: "Supports 90+ databases",
    supportDesc: "Connect SQL, NoSQL, vector, time-series, and embedded databases, message queues, and compatible engines in one place.",
    supportLink: "View all",
    testimonialsTitle: "What DBX is good at",
    testimonialsDesc: "Reviews and coverage from real community sources — HelloGitHub, X, blogs, and YouTube.",
    capabilitiesTitle: "Built for real database work",
    contributorsTitle: "Built by the community",
    contributorsDesc: "DBX is fully open-source. Every feature, fix, and driver starts with a contributor.",
    sponsorsLabel: "❤️ Sponsors",
    partnersLabel: "🤝 Partners",
    qiniuSponsorDesc: "Qiniu Cloud provides DBX with object storage, CDN, and other cloud infrastructure resources.",
    qiniuSponsorAction: "Visit",
    rainyunSponsorDesc: "RainYun is a cloud service provider offering cloud servers, physical servers, game hosting, and developer-friendly infrastructure services.",
    rainyunSponsorAction: "Visit",
    easysearchSponsorDesc: "Easysearch is an enterprise-grade distributed search engine compatible with Elasticsearch APIs, combining full-text, vector, geospatial search, real-time analytics, and AI capabilities in one platform.",
    easysearchSponsorAction: "Visit",
    atlasCloudSponsorDesc: "Atlas Cloud gives developers one unified API for 400+ AI models across chat, image, video, and audio.",
    atlasCloudSponsorAction: "Visit",
    trustasiaSponsorDesc: "TrustAsia provides cloud-based code signing service for DBX, enabling trusted software through automated CI/CD builds.",
    trustasiaSponsorAction: "Visit",
    jalapenoSponsorDesc: "Jalapeño Cloud is an AI infrastructure and token compute platform, with an exclusive DBX entry offering free credits and top-up bonuses.",
    jalapenoSponsorAction: "Visit",
    astraflowSponsorDesc: "UCloud is the first public cloud provider listed on China's STAR Market, with 28 global regions for cloud hosting, databases, and CDN; its AstraFlow platform offers one-click access to 200+ mainstream LLMs.",
    astraflowSponsorAction: "Visit",
    onepanelSponsorDesc: "1Panel is a modern open-source Linux server management panel and lightweight AI management platform, offering an intuitive web interface for one-stop management of AI agents, local LLMs, websites, databases, containers, files, and more.",
    onepanelSponsorAction: "Visit",
    hualongSponsorDesc: "HuaLongAI is a model API relay built for heavy AI developers, offering 100% official-source Codex and Claude models with transparent token-level billing, enterprise contracts, and invoicing.",
    hualongSponsorAction: "Visit",
    footerTitle: "Ready to try DBX?",
    footerDesc: "Use the desktop app for local work, or deploy the Docker version for browser-based access.",
    release: "Latest release",
    docker: "Docker setup",
  },
  cn: {
    heroTitle: "25MB，管理90+种数据库！",
    heroSubtitle: "DBX 将连接管理、SQL 编辑、数据表格、结构工具、AI 助手和自托管访问放进一个轻量产品里。",
    download: "下载 DBX",
    downloadName: "下载 DBX",
    readDocs: "查看文档",
    docsStart: "从这里开始",
    docsStartDesc: "安装 DBX、创建第一个连接，并了解主要工作流。",
    workflowsTitle: "核心工作流",
    workflowsDesc: "文档围绕数据库客户端里的真实任务组织，而不是堆功能清单。",
    supportTitle: "支持90+种数据库",
    supportDesc: "统一连接和管理 SQL、NoSQL、向量、时序、嵌入式数据库、消息队列及兼容引擎。",
    supportLink: "查看全部",
    testimonialsTitle: "DBX 适合什么样的工作",
    testimonialsDesc: "以下评价与收录均来自 HelloGitHub、X、知乎、博客园、掘金、linux.do 等真实社区来源。",
    capabilitiesTitle: "面向真实数据库工作的能力",
    contributorsTitle: "社区共建",
    contributorsDesc: "DBX 因每一位贡献者而生长",
    sponsorsLabel: "❤️ 赞助商",
    partnersLabel: "🤝 合作伙伴",
    qiniuSponsorDesc: "七牛云为 DBX 提供对象存储、CDN 等云基础设施资源支持。",
    qiniuSponsorAction: "访问",
    rainyunSponsorDesc: "雨云是面向开发者和站长的云服务提供商，提供云服务器、物理服务器、游戏云和配套基础设施服务。",
    rainyunSponsorAction: "访问",
    easysearchSponsorDesc: "Easysearch 是一款企业级分布式搜索引擎，兼容 ES API、融合全文检索、向量检索、地理空间位置检索、实时分析与 AI 能力，为企业提供统一的数据检索与智能分析基础设施。",
    easysearchSponsorAction: "访问",
    atlasCloudSponsorDesc: "Atlas Cloud 为开发者提供统一的多模态 AI API，可通过一个接口访问聊天、图像、视频和音频等 400+ 模型。",
    atlasCloudSponsorAction: "访问",
    trustasiaSponsorDesc: "由 TrustAsia 提供代码签名云签服务，实现 CICD 自动化构建可信软件。",
    trustasiaSponsorAction: "访问",
    jalapenoSponsorDesc: "Jalapeño Cloud 是 AI 基础设施与 Token 算力平台，通过 DBX 专属入口可享新用户免费额度与充值加赠。",
    jalapenoSponsorAction: "访问",
    astraflowSponsorDesc: "UCloud 优刻得是国内首家公有云科创板上市公司，覆盖国内、亚洲、欧洲、北美等 28 个地域的云主机、数据库、CDN 等服务，注册享新客优惠 0.9 折起；星图 AstraFlow 大模型平台支持主流 200+ 大模型一键调用。",
    astraflowSponsorAction: "访问",
    onepanelSponsorDesc: "1Panel 是现代化的开源 Linux 服务器运维管理面板与轻量级 AI 管理平台，提供直观易用的 Web 界面，支持 AI 智能体、本地大模型、网站、数据库、容器、文件等核心场景的一站式管理。",
    onepanelSponsorAction: "访问",
    hualongSponsorDesc: "HuaLongAI（华龙算力）是面向重度 AI 开发者的模型 API 中转服务商，主营 Codex 与 Claude 系列模型，100% 官方源直供、不掺假；计费透明，Token 级账单可逐笔核验，支持企业合同与发票。",
    hualongSponsorAction: "访问",
    footerTitle: "准备试试 DBX？",
    footerDesc: "本地工作使用桌面版，需要浏览器访问时部署 Docker 版。",
    release: "最新版本",
    docker: "Docker 部署",
  },
};

const landingMeta = {
  en: {
    title: "DBX - 25 MB to manage 90+ databases!",
    description: "DBX brings connections, SQL editing, data grids, schema tools, AI assistance, and self-hosted access into one lightweight product.",
  },
  cn: {
    title: "DBX - 25MB，管理90+种数据库！",
    description: "DBX 将连接管理、SQL 编辑、数据表格、结构工具、AI 助手和自托管访问放进一个轻量产品里。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = resolveLang(lang);
  const meta = landingMeta[l];

  return buildMetadata({
    title: meta.title,
    description: meta.description,
    path: `/${l}`,
    lang: l,
    ogType: "website",
  });
}

export default async function LandingPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const l = resolveLang(lang);
  const t = i18nText[l];
  const workflowItems = workflows[l];
  const capabilityItems = capabilities[l];
  const contributorData = contributorSnapshot as ContributorActivityData;
  const starLabel = formatStars(contributorData.stars);
  const metricItems = metrics(starLabel)[l];
  const appVersion = getAppVersion();
  const initialLatestRelease = await fetchLatestReleaseInfo();
  const contributors = contributorsFromActivity(contributorData.contributors);
  const initialDownloadVersion = initialLatestRelease?.version ?? appVersion;
  const testimonialItems = localizedTestimonials[l];
  const softwareStructuredData = buildSoftwareApplicationStructuredData(l, initialDownloadVersion);
  const sponsorItems = [
    {
      name: "RainYun",
      href: "https://www.rainyun.com/MTE5Mjc4Ng==_",
      logo: "https://www.rainyun.com/img/logo.d193755d.png",
      logoClass: "h-10 w-auto max-w-[100px]",
      description: t.rainyunSponsorDesc,
      action: t.rainyunSponsorAction,
    },
    {
      name: "TrustAsia",
      href: "https://www.trustasia.com/ssl/trustasia/code-signing",
      logo: "/sponsors/trustasia.png",
      logoClass: "w-full max-w-[120px] object-contain",
      description: t.trustasiaSponsorDesc,
      action: t.trustasiaSponsorAction,
    },
    {
      name: "Jalapeño Cloud",
      href: "https://www.jalapeno-cloud.ai/DBX",
      logo: "/sponsors/jalapeno-card.png",
      logoClass: "w-full max-w-[96px] object-contain",
      description: t.jalapenoSponsorDesc,
      action: t.jalapenoSponsorAction,
    },
    {
      name: "AstraFlow",
      href: "https://www.ucloud.cn/site/active/kuaijiesale.html?ytag=geo_waituo_github_dbx",
      logo: "/sponsors/astraflow-card.png",
      logoClass: "w-full max-w-[100px] object-contain",
      description: t.astraflowSponsorDesc,
      action: t.astraflowSponsorAction,
    },
    {
      name: "HuaLongAI",
      href: "https://api.hualong.online/register?promo=DBX%26HUALONG",
      logo: "/sponsors/hualong-card.png",
      logoClass: "w-full max-w-[120px] object-contain",
      description: t.hualongSponsorDesc,
      action: t.hualongSponsorAction,
    },
    {
      name: "Atlas Cloud",
      href: "https://www.atlascloud.ai/?ref=6YYXWA",
      logo: "https://www.atlascloud.ai/logo.svg",
      logoClass: "w-full max-w-[100px] object-contain",
      description: t.atlasCloudSponsorDesc,
      action: t.atlasCloudSponsorAction,
    },
    {
      name: l === "cn" ? "七牛云" : "Qiniu Cloud",
      href: "https://www.qiniu.com/",
      logo: "https://www-static.qbox.me/_next/static/media/logo.0fc18feaa621d2068a7180631f742256.jpg",
      logoClass: "h-14 w-14 object-contain",
      description: t.qiniuSponsorDesc,
      action: t.qiniuSponsorAction,
    },
  ];
  const partnerItems = [
    {
      name: "1Panel",
      href: "https://1panel.cn/",
      logo: "/sponsors/1panel-card.png",
      logoClass: "w-full max-w-[100px] object-contain",
      description: t.onepanelSponsorDesc,
      action: t.onepanelSponsorAction,
    },
    {
      name: "Easysearch",
      href: "https://easysearch.cn",
      logo: "/sponsors/easysearch.png",
      logoClass: "w-full max-w-[100px] object-contain",
      description: t.easysearchSponsorDesc,
      action: t.easysearchSponsorAction,
    },
  ];

  return (
    <main className="landing" lang={getHtmlLang(l)}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareStructuredData) }} />
      {/* 漫游星空背景层：铺满整个深色着陆页，克制不抢焦点 */}
      <Starfield />
      {/* Nav */}
      <LandingNav lang={l} active="home" />

      {/* Hero */}
      <section className="landing-hero" aria-labelledby="landing-title">
        <Spotlight />
        <div className="relative z-[1] max-w-[1180px] mx-auto px-7 max-[1040px]:max-w-[920px] max-[760px]:px-[18px]">
          <div className="landing-hero-copy relative z-[6] grid justify-items-center max-w-[900px] mx-auto text-center max-[1040px]:max-w-[760px]">
            <h1 id="landing-title" className="min-w-0 m-0 text-[clamp(36px,4.2vw,56px)] font-[820] leading-[1.06] text-landing-ink whitespace-nowrap max-[760px]:max-w-[12ch] max-[760px]:whitespace-normal max-[760px]:text-balance max-[760px]:text-[clamp(29px,8.7vw,38px)] max-[760px]:leading-[1.08]">
              {t.heroTitle}
            </h1>
            <p className="landing-hero-subtitle min-w-0 mt-5 mx-auto text-[17px] font-[460] leading-[1.8] whitespace-nowrap max-[900px]:max-w-[680px] max-[900px]:whitespace-normal max-[760px]:max-w-[320px] max-[760px]:text-[15px] max-[760px]:leading-[1.68]">{t.heroSubtitle}</p>
            <div className="w-full max-w-[520px] mt-10 max-[760px]:mt-7">
              <InstallTabs lang={l} version={initialDownloadVersion} />
            </div>
          </div>
          <HeroProductStage />
        </div>
      </section>

      {/* Metrics */}
      <RevealSection className="grid grid-cols-4 gap-3 max-w-[1180px] mx-auto px-7 pt-6 pb-11 [animation:landing-rise_0.72s_ease-out_0.1s_both] max-[760px]:grid-cols-2 max-[760px]:gap-2.5 max-[760px]:px-[18px] max-[760px]:pb-7" aria-label={METRICS_LABEL[l]}>
        {metricItems.map((item) => (
          <div key={item.label} data-stagger className="landing-glass-card min-h-[118px] rounded-[10px] p-[22px] max-[760px]:min-h-[88px] max-[760px]:p-4">
            <strong className="block text-landing-ink text-2xl font-[720]">{item.value}</strong>
            <span className="block mt-1 text-landing-muted text-[13px]">{item.label}</span>
          </div>
        ))}
      </RevealSection>

      {/* Doc start */}
      <RevealSection className="landing-glass-card-green flex items-center justify-between gap-[22px] max-w-[calc(1180px-56px)] mx-auto px-7 py-7 rounded-[10px] max-[760px]:block max-[760px]:mx-[18px] max-[760px]:px-[18px] max-[760px]:py-5">
        <div>
          <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{t.docsStart}</h2>
          <p className="mt-2 text-landing-muted text-sm leading-[1.65]">{t.docsStartDesc}</p>
        </div>
        <Link href={`/${l}/docs/getting-started`} prefetch={false} className="landing-inline-link flex shrink-0 items-center gap-[7px] text-sm font-[650] max-[760px]:mt-4" target="_blank">
          {t.readDocs}
          <ArrowRight size={15} />
        </Link>
      </RevealSection>

      {/* Workflows */}
      <RevealSection className="max-w-[1180px] mx-auto px-7 pt-[70px] pb-1 max-[760px]:px-[18px]">
        <div className="grid grid-cols-[minmax(220px,0.42fr)_minmax(0,0.58fr)] gap-9 items-end mb-[22px] max-[760px]:block">
          <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{t.workflowsTitle}</h2>
          <p className="mt-2 max-w-[650px] text-landing-muted text-sm leading-[1.65] justify-self-end text-right max-[760px]:max-w-none max-[760px]:text-left">{t.workflowsDesc}</p>
        </div>
        <div className="landing-workflow-grid grid grid-cols-4 rounded-[10px] overflow-hidden max-[1040px]:grid-cols-2 max-[760px]:grid-cols-2 max-[360px]:grid-cols-1">
          {workflowItems.map((item, i) => (
            <Link key={item.title} href={item.href} prefetch={false} className={`landing-workflow-card min-h-[250px] p-6 border-r border-r-landing-line max-[760px]:min-h-0 max-[760px]:p-[18px] ${i === workflowItems.length - 1 ? "border-r-0" : ""}`} target="_blank" data-stagger>
              <item.icon size={20} className="text-landing-blue" />
              <h3 className="mt-[18px] text-base font-bold">{item.title}</h3>
              <p className="mt-2.5 text-landing-muted text-[13px] leading-[1.62]">{item.desc}</p>
              <span className="inline-flex items-center gap-1.5 mt-[18px] text-landing-ink text-[13px] font-[650]">
                {t.readDocs}
                <ArrowRight size={14} />
              </span>
            </Link>
          ))}
        </div>
      </RevealSection>

      {/* Database support */}
      <RevealSection className="relative max-w-[1180px] mx-auto px-7 pt-[70px] pb-1 max-[760px]:px-[18px]">
        <div className="grid grid-cols-[minmax(260px,0.28fr)_minmax(0,0.72fr)] gap-9 items-end mb-[30px] max-[760px]:block">
          <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{t.supportTitle}</h2>
          <div className="flex items-center justify-end gap-5 justify-self-end max-w-[760px] text-right max-[760px]:block max-[760px]:max-w-none max-[760px]:text-left">
            <p className="m-0 text-landing-muted text-sm leading-[1.65]">{t.supportDesc}</p>
            <Link href={`/${l}/databases`} prefetch={false} className="landing-inline-link inline-flex shrink-0 items-center gap-[7px] text-sm font-[650] max-[760px]:mt-3">
              {t.supportLink}
              <ArrowRight size={15} />
            </Link>
          </div>
        </div>
        <DatabasePillMarquee items={databaseSupport.filter((db) => !db.href)} />
      </RevealSection>

      {/* Testimonials */}
      <RevealSection className="max-w-[1180px] mx-auto px-7 pt-[70px] pb-1 overflow-hidden max-[760px]:px-[18px]">
        <div className="grid grid-cols-[minmax(220px,0.42fr)_minmax(0,0.58fr)] gap-9 items-end mb-[22px] max-[760px]:block">
          <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{t.testimonialsTitle}</h2>
          <p className="mt-2 max-w-[650px] text-landing-muted text-sm leading-[1.65] justify-self-end text-right max-[760px]:max-w-none max-[760px]:text-left">{t.testimonialsDesc}</p>
        </div>
        <div className="landing-testimonial-wall relative grid gap-3.5 -mx-7 py-1 max-[760px]:-mx-[18px] max-[760px]:mt-[18px]">
          {/* 跑马灯每行至少 4 张卡（1416px）才能盖住 1236px 容器，避免循环接缝 */}
          {(() => {
            const half = Math.ceil(testimonialItems.length / 2);
            return (
              <>
                <InfiniteMovingCards items={testimonialItems.slice(0, half)} speed="slow" />
                <InfiniteMovingCards items={testimonialItems.slice(half)} direction="right" speed="slow" />
              </>
            );
          })()}
        </div>
      </RevealSection>

      {/* Capabilities */}
      <RevealSection className="max-w-[1180px] mx-auto px-7 pt-[70px] pb-1 max-[760px]:px-[18px]">
        <div className="grid grid-cols-[minmax(220px,0.42fr)_minmax(0,0.58fr)] gap-9 items-end mb-[22px] max-[760px]:block">
          <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{t.capabilitiesTitle}</h2>
        </div>
        <div className="grid grid-cols-3 gap-2.5 max-[1040px]:grid-cols-2 max-[760px]:grid-cols-2 max-[760px]:mt-[18px] max-[360px]:grid-cols-1">
          {capabilityItems.map((item) => (
            <div key={item.label} className="landing-capability flex items-center gap-2.5 min-h-[72px] rounded-lg px-[15px] py-3.5 max-[760px]:min-h-[62px] max-[760px]:px-3" data-stagger>
              <item.icon size={18} className="shrink-0 text-landing-blue" />
              <span className="text-landing-ink text-[13px] font-[560] leading-[1.45]">{item.label}</span>
            </div>
          ))}
        </div>
      </RevealSection>

      {/* Contributors */}
      <RevealSection className="max-w-[1180px] mx-auto px-7 pt-[70px] pb-1 max-[760px]:px-[18px]">
        <ContributorsWallContent contributors={contributors} title={t.contributorsTitle} desc={t.contributorsDesc} lang={l} />
      </RevealSection>

      {/* Sponsor */}
      <RevealSection className="max-w-[1180px] mx-auto px-7 mt-10 max-[760px]:px-[18px]">
        <p className="m-0 text-xs font-[720] uppercase tracking-[0.18em] text-landing-blue">{t.sponsorsLabel}</p>
        <div className="landing-sponsor-grid mt-3 grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
          {sponsorItems.map((sponsor) => (
            <Link key={sponsor.name} href={sponsor.href} target="_blank" rel="noopener noreferrer" className="landing-sponsor-card flex min-h-[154px] items-center gap-5 rounded-[10px] border border-landing-line bg-landing-panel px-5 py-4 transition-colors hover:border-landing-blue max-[560px]:block">
              <div className="flex h-20 w-28 shrink-0 items-center justify-center rounded-lg bg-white px-4 py-3 shadow-[0_10px_30px_rgba(15,23,42,0.08)] max-[560px]:mb-3">
                <img src={sponsor.logo} alt={sponsor.name} width={112} height={56} loading="lazy" decoding="async" className={sponsor.logoClass} />
              </div>
              <div className="min-w-0 flex-1 max-[560px]:mt-4">
                <div className="flex items-center gap-x-2.5">
                  <h2 className="text-lg font-[720] text-landing-ink">{sponsor.name}</h2>
                  <span className="landing-inline-link ml-auto inline-flex shrink-0 items-center gap-[7px] text-sm font-[650]">
                    {sponsor.action}
                    <span aria-hidden="true">→</span>
                  </span>
                </div>
                <p className="mt-1.5 text-sm leading-[1.65] text-landing-muted">{sponsor.description}</p>
              </div>
            </Link>
          ))}
        </div>
        <p className="m-0 mt-9 text-xs font-[720] uppercase tracking-[0.18em] text-landing-blue">{t.partnersLabel}</p>
        <div className="landing-sponsor-grid mt-3 grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
          {partnerItems.map((sponsor) => (
            <Link key={sponsor.name} href={sponsor.href} target="_blank" rel="noopener noreferrer" className="landing-sponsor-card flex min-h-[154px] items-center gap-5 rounded-[10px] border border-landing-line bg-landing-panel px-5 py-4 transition-colors hover:border-landing-blue max-[560px]:block">
              <div className="flex h-20 w-28 shrink-0 items-center justify-center rounded-lg bg-white px-4 py-3 shadow-[0_10px_30px_rgba(15,23,42,0.08)] max-[560px]:mb-3">
                <img src={sponsor.logo} alt={sponsor.name} width={112} height={56} loading="lazy" decoding="async" className={sponsor.logoClass} />
              </div>
              <div className="min-w-0 flex-1 max-[560px]:mt-4">
                <div className="flex items-center gap-x-2.5">
                  <h2 className="text-lg font-[720] text-landing-ink">{sponsor.name}</h2>
                  <span className="landing-inline-link ml-auto inline-flex shrink-0 items-center gap-[7px] text-sm font-[650]">
                    {sponsor.action}
                    <span aria-hidden="true">→</span>
                  </span>
                </div>
                <p className="mt-1.5 text-sm leading-[1.65] text-landing-muted">{sponsor.description}</p>
              </div>
            </Link>
          ))}
        </div>
      </RevealSection>

      {/* Final CTA */}
      <RevealSection className="flex items-center justify-between gap-6 max-w-[1180px] mx-auto px-7 border border-landing-line rounded-[10px] bg-landing-panel mt-[72px] mb-14 py-[30px] max-[760px]:block max-[760px]:px-[18px]">
        <div>
          <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{t.footerTitle}</h2>
          <p className="mt-2 text-landing-muted text-sm leading-[1.65]">{t.footerDesc}</p>
        </div>
        <div className="flex items-center gap-2.5 flex-wrap justify-end max-[760px]:mt-[18px]">
          <Link href="https://github.com/t8y2/dbx/releases/latest" target="_blank" className="landing-final-link inline-flex items-center justify-center min-h-[42px] rounded-[7px] px-[15px] text-sm font-[650]">
            {t.release}
          </Link>
          <Link href={`/${l}/docs/getting-started#docker`} prefetch={false} target="_blank" className="landing-final-link inline-flex items-center justify-center min-h-[42px] rounded-[7px] px-[15px] text-sm font-[650]">
            {t.docker}
          </Link>
        </div>
      </RevealSection>

      <LandingFooter lang={l} />
    </main>
  );
}
