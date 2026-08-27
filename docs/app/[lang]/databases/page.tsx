import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { LandingNav } from "@/components/landing/LandingNav";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { Spotlight } from "@/components/aceternity/Spotlight";
import { RevealSection } from "@/components/landing/RevealSection";
import { ExpandableDatabaseGrid } from "@/components/landing/ExpandableDatabaseGrid";
import { databaseSupport } from "@/data/databaseSupport";
import { buildMetadata } from "@/lib/metadata";

const i18n = {
  en: {
    title: "Supported Databases",
    desc: "DBX connects to 90+ database engines. Native Rust drivers, MySQL/PostgreSQL-compatible profiles, and JDBC for everything else.",
    ctaTitle: "Don't see your database?",
    ctaDesc: "Open a GitHub Discussion to request support for a new database engine.",
    ctaLink: "Request on GitHub",
    footer: "Want to learn more about what works with each engine?",
    footerLink: "Read the feature matrix",
  },
  cn: {
    title: "支持的数据库",
    desc: "DBX 支持 90+ 种数据库引擎。涵盖 Rust 原生驱动、MySQL/PostgreSQL 兼容类型和 JDBC 扩展。",
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
    <main className="min-h-screen bg-[#08080a] text-landing-ink">
      <LandingNav lang={l} active="databases" />

      {/* Hero */}
      <section className="relative overflow-hidden pt-28 pb-6">
        <Spotlight />
        <div className="relative z-[1] max-w-[1180px] mx-auto px-7 max-[760px]:px-[18px]">
          <h1 className="text-4xl font-[820] tracking-tight">{t.title}</h1>
          <p className="mt-3 text-landing-muted text-lg max-w-[640px]">{t.desc}</p>
        </div>
      </section>

      {/* Database Grid */}
      <RevealSection className="max-w-[1180px] mx-auto px-7 pb-10 max-[760px]:px-[18px]">
        <ExpandableDatabaseGrid lang={l}>
          {databaseSupport.map((db) => {
            const isCta = "href" in db && db.href;
            const nameSizeClass = db.name.length >= 14
              ? "text-[11px] tracking-[-0.035em] max-[760px]:text-[9px]"
              : db.name.length >= 11
                ? "text-xs tracking-[-0.015em] max-[760px]:text-[10px]"
                : "text-sm max-[760px]:text-[11px]";
            const CardTag = isCta ? "a" : "div";
            return (
              <CardTag
                className={`landing-db-card grid place-items-center aspect-square rounded-[10px] px-2.5 py-[18px] max-[760px]:px-1.5 max-[760px]:py-2.5 ${isCta ? "border-2 border-dashed border-[color-mix(in_srgb,var(--color-landing-blue)_40%,transparent)] hover:border-[color-mix(in_srgb,var(--color-landing-blue)_70%,transparent)] transition-colors cursor-pointer" : ""}`}
                key={db.name}
                {...(isCta ? { href: db.href, target: "_blank", rel: "noopener noreferrer" } : {})}
                style={{ "--db-tone": db.tone } as CSSProperties}
                data-stagger
              >
                <div className="landing-db-icon grid place-items-center w-12 h-12 mb-[15px] max-[760px]:size-8 max-[760px]:mb-2">
                  {isCta ? (
                    <span className="grid place-items-center w-10 h-10 rounded-full border-2 border-dashed text-landing-blue border-landing-blue text-2xl leading-none">+</span>
                  ) : (
                    <img src={db.icon} alt="" width={38} height={38} loading="lazy" decoding="async" className="block w-[38px] h-[38px] object-contain max-[760px]:size-7" />
                  )}
                </div>
                <strong className={`block w-full min-w-0 px-1 font-[650] leading-[1.2] text-center [overflow-wrap:anywhere] min-[761px]:whitespace-nowrap ${nameSizeClass} ${isCta ? "text-landing-blue" : "text-[color-mix(in_srgb,var(--color-landing-ink)_92%,var(--color-landing-muted))]"}`}>{db.name}</strong>
              </CardTag>
            );
          })}
        </ExpandableDatabaseGrid>
      </RevealSection>

      {/* Vendor CTA */}
      <RevealSection className="max-w-[1180px] mx-auto px-7 pb-16 max-[760px]:px-[18px]">
        <div className="landing-glass-card rounded-[10px] p-8 text-center max-w-[640px] mx-auto">
          <h2 className="text-[21px] font-[720]">{t.ctaTitle}</h2>
          <p className="mt-2 text-landing-muted text-sm leading-[1.65]">{t.ctaDesc}</p>
          <Link href="https://github.com/t8y2/dbx/discussions" target="_blank" className="landing-final-link inline-flex items-center justify-center min-h-[42px] rounded-[7px] px-5 mt-5 text-sm font-[650]">
            {t.ctaLink}
          </Link>
        </div>
      </RevealSection>

      {/* Footer link to docs */}
      <div className="max-w-[1180px] mx-auto px-7 pb-20 text-center max-[760px]:px-[18px]">
        <Link href={`/${l}/docs/databases`} className="landing-inline-link inline-flex items-center gap-[7px] text-sm font-[650]">
          {t.footerLink}
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </Link>
      </div>

      <LandingFooter lang={l} />
    </main>
  );
}
