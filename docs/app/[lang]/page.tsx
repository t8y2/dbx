import Link from "next/link";
import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { HeroProductStage } from "@/components/aceternity/HeroProductStage";
import { InfiniteMovingCards } from "@/components/aceternity/InfiniteMovingCards";
import { Spotlight } from "@/components/aceternity/Spotlight";
import { LandingNav } from "@/components/landing/LandingNav";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { InstallTabs } from "@/components/landing/InstallTabs";
import { LandingLatestUpdates } from "@/components/landing/LandingLatestUpdates";
import { RevealSection } from "@/components/landing/RevealSection";
import { ContributorsWallContent } from "@/components/landing/ContributorsWall";
import { fetchContributors } from "@/lib/contributors";
import { getAppVersion } from "@/lib/appVersion";
import { fetchChangelog } from "@/lib/changelog";
import { fetchLatestReleaseInfo } from "@/lib/latestRelease";
import { ArrowRight, Bot, Database, FileCode, GitCompare, Network, Search, Shield, Table, Terminal, Zap } from "lucide-react";

const fallbackStarLabel = "1.3k+";

function formatStars(count: number) {
  if (count >= 1000) {
    return `${(Math.floor(count / 100) / 10).toFixed(1)}k+`;
  }

  return `${count}+`;
}

async function getGitHubStarLabel() {
  try {
    const response = await fetch("https://api.github.com/repos/t8y2/dbx", {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 60 * 60 * 6 },
    });

    if (!response.ok) return fallbackStarLabel;

    const data = (await response.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number" ? formatStars(data.stargazers_count) : fallbackStarLabel;
  } catch {
    return fallbackStarLabel;
  }
}

function metrics(starLabel: string) {
  return {
    en: [
      { value: "~20 MB", label: "desktop installer" },
      { value: "60+", label: "database engines" },
      { value: "2 modes", label: "desktop and Docker" },
      { value: starLabel, label: "GitHub stars, fully open-source" },
    ],
    cn: [
      { value: "~20 MB", label: "桌面安装包" },
      { value: "60+", label: "数据库引擎" },
      { value: "2 种模式", label: "桌面与 Docker" },
      { value: starLabel, label: "GitHub Star，完全开源" },
    ],
  };
}

const databaseSupport = [
  { name: "MySQL", icon: "/icons/database/mysql.svg", tone: "#4479a1" },
  { name: "PostgreSQL", icon: "/icons/database/postgres.svg", tone: "#4169e1" },
  { name: "SQLite", icon: "/icons/database/sqlite.svg", tone: "#5aa6d6" },
  { name: "Redis", icon: "/icons/database/redis.svg", tone: "#ff4438" },
  { name: "DuckDB", icon: "/icons/database/duckdb.svg", tone: "#fff000" },
  { name: "ClickHouse", icon: "/icons/database/clickhouse.svg", tone: "#ffcc01" },
  { name: "SQL Server", icon: "/icons/database/sqlserver.svg", tone: "#9ca3af" },
  { name: "MongoDB", icon: "/icons/database/mongodb.svg", tone: "#47a248" },
  { name: "Oracle", icon: "/icons/database/oracle.svg", tone: "#f80000" },
  { name: "Elasticsearch", icon: "/icons/database/elasticsearch.svg", tone: "#00bfb3" },
  { name: "Qdrant", icon: "/icons/database/qdrant.svg", tone: "#dc244c" },
  { name: "Milvus", icon: "/icons/database/milvus.png", tone: "#00a1ea" },
  { name: "Weaviate", icon: "/icons/database/weaviate.png", tone: "#00b894" },
  { name: "ChromaDB", shortLabel: "CH", tone: "#ff7a59" },
  { name: "Cloudflare D1", shortLabel: "D1", tone: "#f6821f" },
  { name: "MariaDB", icon: "/icons/database/mariadb.svg", tone: "#003545" },
  { name: "Doris", icon: "/icons/database/doris.svg", tone: "#5b7cfa" },
  { name: "StarRocks", icon: "/icons/database/starrocks.svg", tone: "#6750ff" },
  { name: "Manticore", icon: "/icons/database/manticoresearch.png", tone: "#b8e646" },
  { name: "Redshift", icon: "/icons/database/redshift.svg", tone: "#8c4fff" },
  { name: "Dameng", icon: "/icons/database/dm.svg", tone: "#3857ff" },
  { name: "GaussDB", icon: "/icons/database/gaussdb.svg", tone: "#ff5a3d" },
  { name: "openGauss", icon: "/icons/database/opengauss.svg", tone: "#1488c9" },
  { name: "KingBase", icon: "/icons/database/kingbase.svg", tone: "#e1212d" },
  { name: "HighGo", icon: "/icons/database/highgo.png", tone: "#005bac" },
  { name: "TiDB", icon: "/icons/database/tidb.svg", tone: "#e60012" },
  { name: "OceanBase", icon: "/icons/database/oceanbase.svg", tone: "#2285ff" },
  { name: "TDSQL", icon: "/icons/database/tdsql.webp", tone: "#0080ff" },
  { name: "PolarDB", icon: "/icons/database/polardb.webp", tone: "#1890ff" },
  { name: "GreatSQL", icon: "/icons/database/greatsql.webp", tone: "#0066b3" },
  { name: "SelectDB", icon: "/icons/database/selectdb.svg", tone: "#22c1c3" },
  { name: "TDengine", icon: "/icons/database/tdengine.svg", tone: "#2f6fff" },
  { name: "CockroachDB", icon: "/icons/database/cockroachdb.svg", tone: "#6933ff" },
  { name: "RQLite", icon: "/icons/database/rqlite.png", tone: "#5a67d8" },
  { name: "Turso", icon: "/icons/database/turso.png", tone: "#10b981" },
  { name: "Databend", icon: "/icons/database/databend.svg", tone: "#f59e0b" },
  { name: "Databricks", icon: "/icons/database/databricks.webp", tone: "#ff5a1f" },
  { name: "Snowflake", icon: "/icons/database/snowflake.svg", tone: "#29b5e8" },
  { name: "BigQuery", icon: "/icons/database/bigquery.svg", tone: "#4285f4" },
  { name: "Trino", icon: "/icons/database/trino.svg", tone: "#dd00a1" },
  { name: "PrestoSQL", icon: "/icons/database/presto.svg", tone: "#5890ff" },
  { name: "Hive", icon: "/icons/database/hive.svg", tone: "#fdcb00" },
  { name: "Apache Spark", shortLabel: "SP", tone: "#e25a1c" },
  { name: "DB2", icon: "/icons/database/db2.svg", tone: "#054ada" },
  { name: "SAP HANA", icon: "/icons/database/saphana.webp", tone: "#008fd3" },
  { name: "Teradata", icon: "/icons/database/teradata.webp", tone: "#f37440" },
  { name: "Vertica", icon: "/icons/database/vertica.webp", tone: "#007dc5" },
  { name: "Exasol", icon: "/icons/database/exasol.webp", tone: "#002b45" },
  { name: "Firebird", icon: "/icons/database/firebird.webp", tone: "#e17000" },
  { name: "Informix", icon: "/icons/database/informix.svg", tone: "#0178c8" },
  { name: "Neo4j", icon: "/icons/database/neo4j.svg", tone: "#018bff" },
  { name: "Cassandra", icon: "/icons/database/cassandra.svg", tone: "#1287b1" },
  { name: "Kylin", icon: "/icons/database/apache_kylin.svg", tone: "#fb8c00" },
  { name: "Dremio", shortLabel: "DR", tone: "#30bdbe" },
  { name: "OSCAR", shortLabel: "OS", tone: "#1b8dff" },
  { name: "InfluxDB", icon: "/icons/database/influxdb.svg", tone: "#22adf6" },
  { name: "QuestDB", icon: "/icons/database/questdb.svg", tone: "#dc2626" },
  { name: "IoTDB", icon: "/icons/database/iotdb.svg", tone: "#3cb371" },
  { name: "KWDB", icon: "/icons/database/kwdb.svg", tone: "#6366f1" },
  { name: "Vastbase", icon: "/icons/database/vastbase.png", tone: "#2563eb" },
  { name: "GoldenDB", icon: "/icons/database/goldendb.png", tone: "#eab308" },
  { name: "YashanDB", icon: "/icons/database/yashandb.png", tone: "#dc2626" },
  { name: "SunDB", icon: "/icons/database/sundb.svg", tone: "#f97316" },
  { name: "XuguDB", icon: "/icons/database/xugu.png", tone: "#84cc16" },
  { name: "GBase", icon: "/icons/database/gbase.webp", tone: "#06b6d4" },
  { name: "Access", icon: "/icons/database/access.png", tone: "#a53346" },
  { name: "H2", icon: "/icons/database/h2.svg", tone: "#f7a81b" },
  { name: "Etcd", icon: "/icons/database/etcd.svg", tone: "#419eda" },
  { name: "ZooKeeper", icon: "/icons/database/zookeeper.svg", tone: "#3b82f6" },
  { name: "Pulsar", icon: "/icons/database/pulsar.svg", tone: "#188fff" },
  { name: "Apache Kafka", shortLabel: "KF", tone: "#231f20" },
  { name: "Nacos", icon: "/icons/database/nacos.png", tone: "#2f80ed" },
  { name: "IRIS", icon: "/icons/database/iris.png", tone: "#0085ca" },
  { name: "JDBC", icon: "/icons/database/jdbc.svg", tone: "#6ea8ff" },
  { name: "Your DB?", icon: "/icons/database/jdbc.svg", tone: "#6ea8ff", href: "https://github.com/t8y2/dbx/discussions", cta: true },
];

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
    heroTitle: "20 MB to manage 60+ databases!",
    heroSubtitle: "DBX brings connections, SQL editing, data grids, schema tools, AI assistance, and self-hosted access into one lightweight product.",
    download: "Download DBX",
    downloadName: "Download DBX",
    readDocs: "Read the docs",
    docsStart: "Start here",
    docsStartDesc: "Install DBX, create your first connection, and learn the main workflow.",
    workflowsTitle: "Core workflows",
    workflowsDesc: "The docs are organized around what you actually do in a database client.",
    supportTitle: "Supports many databases",
    supportDesc: "Connect and manage SQL, NoSQL, embedded databases, and MySQL/PostgreSQL-compatible engines without switching tools.",
    testimonialsTitle: "What DBX is good at",
    testimonialsDesc: "A closer look at the everyday database workflows DBX is built to make smoother.",
    capabilitiesTitle: "Built for real database work",
    contributorsTitle: "Built by the community",
    contributorsDesc: "DBX is fully open-source. Every feature, fix, and driver starts with a contributor.",
    footerTitle: "Ready to try DBX?",
    footerDesc: "Use the desktop app for local work, or deploy the Docker version for browser-based access.",
    release: "Latest release",
    docker: "Docker setup",
  },
  cn: {
    heroTitle: "20MB，管理60+种数据库！",
    heroSubtitle: "DBX 将连接管理、SQL 编辑、数据表格、结构工具、AI 助手和自托管访问放进一个轻量产品里。",
    download: "下载 DBX",
    downloadName: "下载 DBX",
    readDocs: "查看文档",
    docsStart: "从这里开始",
    docsStartDesc: "安装 DBX、创建第一个连接，并了解主要工作流。",
    workflowsTitle: "核心工作流",
    workflowsDesc: "文档围绕数据库客户端里的真实任务组织，而不是堆功能清单。",
    supportTitle: "支持多种数据库",
    supportDesc: "告别频繁切换工具的烦恼。DBX 可以连接和管理多种数据库类型，让你更专注于查询、分析和数据本身。",
    testimonialsTitle: "DBX 适合什么样的工作",
    testimonialsDesc: "从连接管理、数据浏览到 AI 辅助，DBX 围绕高频数据库工作流打磨体验。",
    capabilitiesTitle: "面向真实数据库工作的能力",
    contributorsTitle: "社区共建",
    contributorsDesc: "DBX 因每一位贡献者而生长",
    footerTitle: "准备试试 DBX？",
    footerDesc: "本地工作使用桌面版，需要浏览器访问时部署 Docker 版。",
    release: "最新版本",
    docker: "Docker 部署",
  },
};

import { buildMetadata } from "@/lib/metadata";

const landingMeta = {
  en: {
    title: "DBX - 20 MB to manage 60+ databases!",
    description: "DBX brings connections, SQL editing, data grids, schema tools, AI assistance, and self-hosted access into one lightweight product.",
  },
  cn: {
    title: "DBX - 20MB，管理60+种数据库！",
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
  const starLabel = await getGitHubStarLabel();
  const metricItems = metrics(starLabel)[l];
  const appVersion = getAppVersion();
  const [initialChangelog, initialLatestRelease] = await Promise.all([fetchChangelog(l), fetchLatestReleaseInfo()]);
  const contributors = await fetchContributors();
  const initialDownloadVersion = initialLatestRelease?.version ?? appVersion;
  const testimonialItems = testimonials[l];

  return (
    <main className="landing">
      {/* Nav */}
      <LandingNav lang={l} active="home" />

      {/* Hero */}
      <section className="landing-hero">
        <Spotlight />
        <div className="relative z-[1] max-w-[1180px] mx-auto px-7 max-[1040px]:max-w-[920px] max-[760px]:px-[18px]">
          <div className="landing-hero-copy relative z-[6] grid justify-items-center max-w-[900px] mx-auto text-center max-[1040px]:max-w-[760px]">
            <h1 className="min-w-0 m-0 text-[clamp(36px,4.2vw,56px)] font-[820] leading-[1.06] text-landing-ink whitespace-nowrap max-[760px]:text-[clamp(26px,7vw,38px)]">{t.heroTitle}</h1>
            <p className="landing-hero-subtitle min-w-0 mt-5 mx-auto text-[17px] font-[460] leading-[1.8] whitespace-nowrap max-[760px]:text-[15px] max-[760px]:leading-[1.68] max-[760px]:whitespace-normal max-[760px]:max-w-[320px]">{t.heroSubtitle}</p>
            <div className="w-full max-w-[520px] mt-10">
              <InstallTabs lang={l} version={initialDownloadVersion} />
            </div>
          </div>
          <HeroProductStage />
        </div>
      </section>

      {/* Metrics */}
      <RevealSection className="grid grid-cols-4 gap-3 max-w-[1180px] mx-auto px-7 pt-6 pb-11 [animation:landing-rise_0.72s_ease-out_0.1s_both] max-[760px]:grid-cols-1 max-[760px]:px-[18px] max-[760px]:pb-8">
        {metricItems.map((item) => (
          <div key={item.label} data-stagger className="landing-glass-card min-h-[118px] rounded-[10px] p-[22px] max-[760px]:min-h-[96px] max-[760px]:p-[18px]">
            <strong className="block text-landing-ink text-2xl font-[720]">{item.value}</strong>
            <span className="block mt-1 text-landing-muted text-[13px]">{item.label}</span>
          </div>
        ))}
      </RevealSection>

      {/* Doc start */}
      <RevealSection className="landing-glass-card-green flex items-center justify-between gap-[22px] max-w-[calc(1180px-56px)] mx-auto px-7 py-7 rounded-[10px] max-[760px]:block max-[760px]:px-[18px]">
        <div>
          <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{t.docsStart}</h2>
          <p className="mt-2 text-landing-muted text-sm leading-[1.65]">{t.docsStartDesc}</p>
        </div>
        <Link href={`/${l}/docs/getting-started`} className="landing-inline-link flex shrink-0 items-center gap-[7px] text-sm font-[650] max-[760px]:mt-4" target="_blank">
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
        <div className="landing-workflow-grid grid grid-cols-4 rounded-[10px] overflow-hidden max-[1040px]:grid-cols-2 max-[760px]:grid-cols-1">
          {workflowItems.map((item, i) => (
            <Link
              key={item.title}
              href={item.href}
              className={`landing-workflow-card min-h-[250px] p-6 border-r border-r-landing-line max-[760px]:min-h-0 max-[760px]:border-r-0 max-[760px]:border-b max-[760px]:border-b-landing-line max-[760px]:last:border-b-0 ${i === workflowItems.length - 1 ? "border-r-0" : ""}`}
              target="_blank"
              data-stagger
            >
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
          <p className="mt-2 max-w-[760px] text-landing-muted text-sm leading-[1.65] justify-self-end text-right max-[760px]:max-w-none max-[760px]:text-left">{t.supportDesc}</p>
        </div>
        <div className="grid grid-cols-9 gap-3 max-[1240px]:grid-cols-7 max-[960px]:grid-cols-5 max-[640px]:grid-cols-3 max-[440px]:grid-cols-2 max-[760px]:gap-2.5">
          {databaseSupport.map((db) => {
            const isCta = "href" in db && db.href;
            const CardTag = isCta ? "a" : "div";
            return (
            <CardTag
              className={`landing-db-card grid place-items-center aspect-square rounded-[10px] px-2.5 py-[18px] max-[760px]:py-4 ${isCta ? "border-2 border-dashed border-[color-mix(in_srgb,var(--color-landing-blue)_40%,transparent)] hover:border-[color-mix(in_srgb,var(--color-landing-blue)_70%,transparent)] transition-colors cursor-pointer" : ""}`}
              key={db.name}
              {...(isCta ? { href: db.href, target: "_blank", rel: "noopener noreferrer" } : {})}
              style={{ "--db-tone": db.tone } as CSSProperties}
              data-stagger
            >
              <div className="landing-db-icon grid place-items-center w-12 h-12 mb-[15px]">
                {isCta ? (
                  <span className="grid place-items-center w-10 h-10 rounded-full border-2 border-dashed text-landing-blue border-landing-blue text-2xl leading-none">+</span>
                ) : db.icon ? (
                  <img src={db.icon} alt="" width={38} height={38} className="block w-[38px] h-[38px] object-contain" />
                ) : (
                  <span className="grid place-items-center min-w-[46px] h-8 rounded-lg px-2 text-xs font-[780] text-white" style={{ backgroundColor: db.tone }}>{db.shortLabel ?? db.name.slice(0, 2).toUpperCase()}</span>
                )}
              </div>
              <strong className={`text-sm font-[650] leading-[1.2] text-center ${isCta ? "text-landing-blue" : "text-[color-mix(in_srgb,var(--color-landing-ink)_92%,var(--color-landing-muted))]"}`}>{db.name}</strong>
            </CardTag>
            );
          })}
        </div>
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
        <div className="grid grid-cols-3 gap-2.5 max-[1040px]:grid-cols-2 max-[760px]:grid-cols-1 max-[760px]:mt-[18px]">
          {capabilityItems.map((item) => (
            <div key={item.label} className="landing-capability flex items-center gap-2.5 min-h-[72px] rounded-lg px-[15px] py-3.5" data-stagger>
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

      {/* Updates */}
      <LandingLatestUpdates lang={l} fallbackVersion={appVersion} initialRelease={initialChangelog.releases[0]} initialLatestRelease={initialLatestRelease} />

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
          <Link href={`/${l}/docs/getting-started#docker`} target="_blank" className="landing-final-link inline-flex items-center justify-center min-h-[42px] rounded-[7px] px-[15px] text-sm font-[650]">
            {t.docker}
          </Link>
        </div>
      </RevealSection>

      <LandingFooter lang={l} />
    </main>
  );
}
