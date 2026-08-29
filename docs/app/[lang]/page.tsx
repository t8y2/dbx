import Link from "next/link";
import type { Metadata } from "next";
import { HeroProductStage } from "@/components/aceternity/HeroProductStage";
import { InfiniteMovingCards } from "@/components/aceternity/InfiniteMovingCards";
import { Spotlight } from "@/components/aceternity/Spotlight";
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

function formatStars(count: number) {
  if (count >= 1000) {
    return `${(Math.floor(count / 100) / 10).toFixed(1)}k+`;
  }

  return `${count}+`;
}

function metrics(starLabel: string) {
  return {
    en: [
      { value: "~20 MB", label: "desktop installer" },
      { value: "90+", label: "database engines" },
      { value: "2 modes", label: "desktop and Docker" },
      { value: starLabel, label: "GitHub stars, fully open-source" },
    ],
    cn: [
      { value: "~20 MB", label: "桌面安装包" },
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
      name: "@cyano",
      role: "PostgreSQL and Redis workflows",
      avatar: "/avatars/cyano.jpg",
      quote: "DBX keeps query work, schema checks, and Redis inspection in one small app. It feels focused instead of overloaded.",
    },
    {
      name: "eryajf",
      role: "Database management",
      avatar: "/avatars/eryajf.jpg",
      quote: "Try it once and you can feel it: DBX is the database management client that ends the competition.",
    },
    {
      name: "@vbvb",
      role: "Daily reporting",
      avatar: "/avatars/vbvb.png",
      quote: "The data grid and export flow are the parts I reach for every day. Filters, previews, and edits stay close to the data.",
    },
    {
      name: "@ar414",
      role: "Self-hosted tooling",
      avatar: "/avatars/ar414.jpg",
      quote: "Desktop mode is light enough for local work, and Docker mode makes it easy to give the team browser access.",
    },
    {
      name: "@ryan",
      role: "Multi-database projects",
      avatar: "/avatars/ryan.jpg",
      quote: "I can jump between SQLite, MySQL, MongoDB, and DuckDB without changing tools or waiting on a heavy runtime.",
    },
    {
      name: "@acane",
      role: "Schema review",
      avatar: "/avatars/acane.png",
      quote: "Schema browsing, ER diagrams, and diff tools make reviews faster because the important context is already connected.",
    },
    {
      name: "@ydwang",
      role: "Agent workflows",
      avatar: "/avatars/ydwang.png",
      quote: "The MCP server is a practical touch. It lets coding agents inspect database context without inventing another bridge.",
    },
    {
      name: "@guangguang",
      role: "Schema navigation",
      avatar: "/avatars/guangguang.jpg",
      quote: "Sidebar search and grouped objects make large schemas manageable. I can find what I need without scrolling through hundreds of tables.",
    },
    {
      name: "@xuyuan",
      role: "SQL editing",
      avatar: "/avatars/xuyuan.jpg",
      quote: "Code completion in the SQL editor picks up column names and table aliases automatically. It saves a lot of tab-switching to check schema.",
    },
    {
      name: "@itkui",
      role: "Data export",
      avatar: "/avatars/itkui.jpg",
      quote: "Export options cover CSV, Excel, and SQL inserts. For daily data pulls, the workflow is quick and doesn't need extra scripting.",
    },
    {
      name: "@mebiuw",
      role: "Secure connections",
      avatar: "/avatars/mebiuw.jpg",
      quote: "SSH tunnel setup is straightforward — fill in the fields and connect. No need to manage port forwarding manually in a terminal.",
    },
    {
      name: "@patrickz",
      role: "Database design",
      avatar: "/avatars/patrickz.jpg",
      quote: "ER diagrams give a clear picture of table relationships. Useful during design reviews when the team needs a shared visual reference.",
    },
    {
      name: "@yanxuecan",
      role: "AI-assisted queries",
      avatar: "/avatars/yanxuecan.jpg",
      quote: "The AI assistant helps draft queries from natural language. It handles routine JOINs and aggregations well enough to speed things up.",
    },
  ],
  cn: [
    {
      name: "不剪发的Tony老师",
      role: "PostgreSQL 与 Redis 工作流",
      avatar: "/avatars/dongxuyang85.jpg",
      quote: "DBX 把查询、结构检查和 Redis 查看放在一个轻量工具里，日常数据库工作不会被复杂界面打断。",
    },
    {
      name: "二丫讲梵",
      role: "数据库管理",
      avatar: "/avatars/eryajf.jpg",
      quote: "只需体验一次你就能感受到，DBX是一个杀死数据库管理客户端比赛的软件",
    },
    {
      name: "Husky明夋",
      role: "报表与数据核对",
      avatar: "/avatars/husky.jpg",
      quote: "数据表格、过滤、预览和导出都离数据很近，用起来像是为高频操作专门整理过。",
    },
    {
      name: "孙志岗",
      role: "团队自托管工具",
      avatar: "/avatars/sunzhigang.jpg",
      quote: "本地桌面版足够轻，自托管 Web 版又方便团队共用，同一个项目覆盖了两种场景。",
    },
    {
      name: "zhufeng",
      role: "多数据库项目",
      avatar: "/avatars/zhufeng.jpg",
      quote: "SQLite、MySQL、MongoDB、DuckDB 来回切换不用换工具，也不用拖着很重的运行时。",
    },
    {
      name: "樱桃小财主",
      role: "结构审查",
      avatar: "/avatars/yingtao.jpg",
      quote: "结构浏览、ER 图和 Schema 对比放在一起，做 review 时上下文更完整。",
    },
    {
      name: "momo",
      role: "Agent 数据库上下文",
      avatar: "/avatars/momo.jpg",
      quote: "MCP Server 很实用，能让编码 Agent 读取数据库上下文，不需要再额外搭桥。",
    },
    {
      name: "逛逛GitHub",
      role: "结构导航",
      avatar: "/avatars/guangguang.jpg",
      quote: "侧边栏搜索和分组浏览让大型 Schema 也不会迷路，不用在几百张表里翻来翻去。",
    },
    {
      name: "序员先生",
      role: "SQL 编辑",
      avatar: "/avatars/xuyuan.jpg",
      quote: "SQL 编辑器的补全能自动识别列名和别名，不用反复切到结构面板去确认字段。",
    },
    {
      name: "IT老魁",
      role: "数据导出",
      avatar: "/avatars/itkui.jpg",
      quote: "导出支持 CSV、Excel 和 INSERT 语句，日常取数据很快，不用再额外写脚本。",
    },
    {
      name: "MebiuW",
      role: "安全连接",
      avatar: "/avatars/mebiuw.jpg",
      quote: "SSH 隧道设置很直接，填好参数就能连，不用在终端里手动转发端口。",
    },
    {
      name: "Patrick Zhang",
      role: "数据库设计",
      avatar: "/avatars/patrickz.jpg",
      quote: "ER 图把表关系展示得很清楚，团队做设计评审时有个共同的可视化参考。",
    },
    {
      name: "闫学灿",
      role: "AI 辅助查询",
      avatar: "/avatars/yanxuecan.jpg",
      quote: "AI 助手能从自然语言生成查询，常规的 JOIN 和聚合写得不错，省了不少手敲时间。",
    },
  ],
};

const i18nText = {
  en: {
    heroTitle: "20 MB to manage 90+ databases!",
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
    testimonialsDesc: "A closer look at the everyday database workflows DBX is built to make smoother.",
    capabilitiesTitle: "Built for real database work",
    contributorsTitle: "Built by the community",
    contributorsDesc: "DBX is fully open-source. Every feature, fix, and driver starts with a contributor.",
    sponsorLabel: "Sponsors & Partners",
    qiniuSponsorDesc: "Qiniu Cloud provides DBX with object storage, CDN, and other cloud infrastructure resources.",
    qiniuSponsorAction: "Visit Qiniu Cloud",
    rainyunSponsorDesc: "RainYun is a cloud service provider offering cloud servers, physical servers, game hosting, and developer-friendly infrastructure services.",
    rainyunSponsorAction: "Visit RainYun",
    easysearchSponsorDesc: "Easysearch is an enterprise-grade distributed search engine compatible with Elasticsearch APIs, combining full-text, vector, geospatial search, real-time analytics, and AI capabilities in one platform.",
    easysearchSponsorAction: "Visit Easysearch",
    atlasCloudSponsorDesc: "Atlas Cloud gives developers one unified API for 400+ AI models across chat, image, video, and audio.",
    atlasCloudSponsorAction: "Visit Atlas Cloud",
    trustasiaSponsorDesc: "TrustAsia provides cloud-based code signing service for DBX, enabling trusted software through automated CI/CD builds.",
    trustasiaSponsorAction: "Visit TrustAsia",
    footerTitle: "Ready to try DBX?",
    footerDesc: "Use the desktop app for local work, or deploy the Docker version for browser-based access.",
    release: "Latest release",
    docker: "Docker setup",
  },
  cn: {
    heroTitle: "20MB，管理90+种数据库！",
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
    testimonialsDesc: "从连接管理、数据浏览到 AI 辅助，DBX 围绕高频数据库工作流打磨体验。",
    capabilitiesTitle: "面向真实数据库工作的能力",
    contributorsTitle: "社区共建",
    contributorsDesc: "DBX 因每一位贡献者而生长",
    sponsorLabel: "赞助商与合作伙伴",
    qiniuSponsorDesc: "七牛云为 DBX 提供对象存储、CDN 等云基础设施资源支持。",
    qiniuSponsorAction: "访问七牛云",
    rainyunSponsorDesc: "雨云是面向开发者和站长的云服务提供商，提供云服务器、物理服务器、游戏云和配套基础设施服务。",
    rainyunSponsorAction: "访问雨云",
    easysearchSponsorDesc: "Easysearch 是一款企业级分布式搜索引擎，兼容 ES API、融合全文检索、向量检索、地理空间位置检索、实时分析与 AI 能力，为企业提供统一的数据检索与智能分析基础设施。",
    easysearchSponsorAction: "访问 Easysearch",
    atlasCloudSponsorDesc: "Atlas Cloud 为开发者提供统一的多模态 AI API，可通过一个接口访问聊天、图像、视频和音频等 400+ 模型。",
    atlasCloudSponsorAction: "访问 Atlas Cloud",
    trustasiaSponsorDesc: "由 TrustAsia 提供代码签名云签服务，实现 CICD 自动化构建可信软件。",
    trustasiaSponsorAction: "访问 TrustAsia",
    footerTitle: "准备试试 DBX？",
    footerDesc: "本地工作使用桌面版，需要浏览器访问时部署 Docker 版。",
    release: "最新版本",
    docker: "Docker 部署",
  },
};

const landingMeta = {
  en: {
    title: "DBX - 20 MB to manage 90+ databases!",
    description: "DBX brings connections, SQL editing, data grids, schema tools, AI assistance, and self-hosted access into one lightweight product.",
  },
  cn: {
    title: "DBX - 20MB，管理90+种数据库！",
    description: "DBX 将连接管理、SQL 编辑、数据表格、结构工具、AI 助手和自托管访问放进一个轻量产品里。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = lang === "cn" ? "cn" : "en";
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
  const l = lang === "cn" ? "cn" : "en";
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
  const testimonialItems = testimonials[l];
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
      name: l === "cn" ? "七牛云" : "Qiniu Cloud",
      href: "https://www.qiniu.com/",
      logo: "https://www-static.qbox.me/_next/static/media/logo.0fc18feaa621d2068a7180631f742256.jpg",
      logoClass: "h-14 w-14 object-contain",
      description: t.qiniuSponsorDesc,
      action: t.qiniuSponsorAction,
    },
    {
      name: "Easysearch",
      href: "https://easysearch.cn",
      logo: "/sponsors/easysearch.png",
      logoClass: "w-full max-w-[100px] object-contain",
      description: t.easysearchSponsorDesc,
      action: t.easysearchSponsorAction,
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
      name: "TrustAsia",
      href: "https://www.trustasia.com/ssl/trustasia/code-signing",
      logo: "/sponsors/trustasia.png",
      logoClass: "w-full max-w-[120px] object-contain",
      description: t.trustasiaSponsorDesc,
      action: t.trustasiaSponsorAction,
    },
  ];

  return (
    <main className="landing" lang={getHtmlLang(l)}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareStructuredData) }} />
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
      <RevealSection className="grid grid-cols-4 gap-3 max-w-[1180px] mx-auto px-7 pt-6 pb-11 [animation:landing-rise_0.72s_ease-out_0.1s_both] max-[760px]:grid-cols-2 max-[760px]:gap-2.5 max-[760px]:px-[18px] max-[760px]:pb-7" aria-label={l === "cn" ? "DBX 核心指标" : "DBX key metrics"}>
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
          <InfiniteMovingCards items={testimonialItems.slice(0, 6)} speed="slow" />
          <InfiniteMovingCards items={testimonialItems.slice(6)} direction="right" speed="slow" />
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
        <p className="m-0 text-xs font-[720] uppercase tracking-[0.18em] text-landing-blue">{t.sponsorLabel}</p>
        <div className="landing-sponsor-grid mt-3 grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
          {sponsorItems.map((sponsor) => (
            <div key={sponsor.name} className="landing-sponsor-card flex min-h-[154px] items-center gap-5 rounded-[10px] border border-landing-line bg-landing-panel px-5 py-4 max-[560px]:block">
              <Link href={sponsor.href} target="_blank" rel="noopener noreferrer" className="flex h-20 w-28 shrink-0 items-center justify-center rounded-lg bg-white px-4 py-3 shadow-[0_10px_30px_rgba(15,23,42,0.08)]">
                <img src={sponsor.logo} alt={sponsor.name} width={112} height={56} loading="lazy" decoding="async" className={sponsor.logoClass} />
              </Link>
              <div className="min-w-0 flex-1 max-[560px]:mt-4">
                <h2 className="text-lg font-[720] text-landing-ink">{sponsor.name}</h2>
                <p className="mt-1.5 text-sm leading-[1.65] text-landing-muted">{sponsor.description}</p>
                <Link href={sponsor.href} target="_blank" rel="noopener noreferrer" className="landing-inline-link mt-3 inline-flex items-center gap-[7px] text-sm font-[650]">
                  {sponsor.action}
                  <span aria-hidden="true">→</span>
                </Link>
              </div>
            </div>
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
