import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { LandingNav } from "@/components/landing/LandingNav";
import { Spotlight } from "@/components/aceternity/Spotlight";
import { RevealSection } from "@/components/landing/RevealSection";
import { buildMetadata } from "@/lib/metadata";

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

const i18n = {
  en: {
    title: "Supported Databases",
    desc: "DBX connects to 70+ database engines. Native Rust drivers, MySQL/PostgreSQL-compatible profiles, and JDBC for everything else.",
    ctaTitle: "Don't see your database?",
    ctaDesc: "Open a GitHub Discussion to request support for a new database engine.",
    ctaLink: "Request on GitHub",
    footer: "Want to learn more about what works with each engine?",
    footerLink: "Read the feature matrix",
  },
  cn: {
    title: "支持的数据库",
    desc: "DBX 支持 70+ 种数据库引擎。涵盖 Rust 原生驱动、MySQL/PostgreSQL 兼容类型和 JDBC 扩展。",
    ctaTitle: "没看到你用的数据库？",
    ctaDesc: "在 GitHub Discussions 中发起讨论，申请支持新的数据库引擎。厂商和社区用户都可以参与。",
    ctaLink: "在 GitHub 上申请",
    footer: "想了解每种引擎具体支持哪些功能？",
    footerLink: "查看功能矩阵",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = lang === "cn" ? "cn" : "en";
  const t = i18n[l];

  return buildMetadata({
    title: t.title,
    description: t.desc,
    path: `/${l}/databases`,
    lang: l,
  });
}

export default async function DatabasesPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const l = lang === "cn" ? "cn" : "en";
  const t = i18n[l];

  return (
    <div className="min-h-screen bg-[#0b1120] text-landing-ink">
      <LandingNav lang={l} active="databases" />

      {/* Hero */}
      <section className="relative pt-28 pb-6">
        <Spotlight />
        <div className="relative z-[1] max-w-[1180px] mx-auto px-7">
          <h1 className="text-4xl font-[820] tracking-tight">{t.title}</h1>
          <p className="mt-3 text-landing-muted text-lg max-w-[640px]">{t.desc}</p>
        </div>
      </section>

      {/* Database Grid */}
      <RevealSection className="max-w-[1180px] mx-auto px-7 pb-10">
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

      {/* Vendor CTA */}
      <RevealSection className="max-w-[1180px] mx-auto px-7 pb-16">
        <div className="landing-glass-card rounded-[10px] p-8 text-center max-w-[640px] mx-auto">
          <h2 className="text-[21px] font-[720]">{t.ctaTitle}</h2>
          <p className="mt-2 text-landing-muted text-sm leading-[1.65]">{t.ctaDesc}</p>
          <Link
            href="https://github.com/t8y2/dbx/discussions"
            target="_blank"
            className="landing-final-link inline-flex items-center justify-center min-h-[42px] rounded-[7px] px-5 mt-5 text-sm font-[650]"
          >
            {t.ctaLink}
          </Link>
        </div>
      </RevealSection>

      {/* Footer link to docs */}
      <div className="max-w-[1180px] mx-auto px-7 pb-20 text-center">
        <Link href={`/${l}/docs/databases`} className="landing-inline-link inline-flex items-center gap-[7px] text-sm font-[650]">
          {t.footerLink}
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </Link>
      </div>
    </div>
  );
}
