"use client";

import Link from "next/link";
import { Github } from "lucide-react";
import { useEffect, useRef } from "react";

const i18n = {
  en: {
    home: "Home",
    docs: "Docs",
    changelog: "Changelog",
    community: "Community",
    sponsors: "Sponsors",
    contributors: "Contributors",
    drivers: "Offline Drivers",
    langLabel: "Switch to Chinese",
  },
  cn: { home: "首页", docs: "文档", changelog: "更新日志", community: "交流群", sponsors: "赞助商", contributors: "贡献者", drivers: "离线驱动", langLabel: "切换到英文" },
};

export function LandingNav({ lang, active }: { lang: "en" | "cn"; active?: "home" | "databases" | "changelog" | "community" | "sponsors" | "contributors" | "drivers" }) {
  const ref = useRef<HTMLElement>(null);
  const t = i18n[lang];
  const otherLang = lang === "cn" ? "en" : "cn";
  const langHrefMap: Record<string, string> = {
    databases: `/${otherLang}/databases`,
    changelog: `/${otherLang}/changelog`,
    community: `/${otherLang}/community`,
    sponsors: `/${otherLang}/sponsors`,
    contributors: `/${otherLang}/contributors`,
    drivers: `/${otherLang}/drivers`,
  };
  const langHref = langHrefMap[active ?? ""] ?? `/${otherLang}`;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    function onScroll() {
      node!.classList.toggle("is-scrolled", window.scrollY > 60);
    }

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav ref={ref} className="landing-nav">
      <div className="flex items-center justify-between max-w-[1180px] h-16 mx-auto px-7 max-[760px]:min-h-[58px] max-[760px]:h-auto max-[760px]:px-[18px] max-[760px]:py-2.5">
        <Link href={`/${lang}`} className="flex items-center gap-2.5 text-landing-ink text-2xl font-[820]">
          <img src="/logo.png" alt="DBX" width={28} height={28} />
          <span>DBX</span>
        </Link>
        <div className="flex items-center gap-1">
          <Link href={`/${lang}`} className={`landing-nav-link rounded-[7px] px-[11px] py-2 text-[13px] font-medium max-[760px]:hidden ${active === "home" ? "text-landing-ink" : "text-landing-muted"}`}>
            {t.home}
          </Link>
          <Link href={`/${lang}/docs/what-is-dbx`} className="landing-nav-link rounded-[7px] px-[11px] py-2 text-[13px] font-medium max-[760px]:hidden text-landing-muted">
            {t.docs}
          </Link>
          <Link href={`/${lang}/changelog`} className={`landing-nav-link rounded-[7px] px-[11px] py-2 text-[13px] font-medium max-[760px]:hidden ${active === "changelog" ? "text-landing-ink" : "text-landing-muted"}`}>
            {t.changelog}
          </Link>
          <Link href={`/${lang}/community`} className={`landing-nav-link rounded-[7px] px-[11px] py-2 text-[13px] font-medium max-[760px]:hidden ${active === "community" ? "text-landing-ink" : "text-landing-muted"}`}>
            {t.community}
          </Link>
          <Link href={`/${lang}/sponsors`} className={`landing-nav-link rounded-[7px] px-[11px] py-2 text-[13px] font-medium max-[900px]:hidden ${active === "sponsors" ? "text-landing-ink" : "text-landing-muted"}`}>
            {t.sponsors}
          </Link>
          <Link href={`/${lang}/contributors`} className={`landing-nav-link rounded-[7px] px-[11px] py-2 text-[13px] font-medium max-[900px]:hidden ${active === "contributors" ? "text-landing-ink" : "text-landing-muted"}`}>
            {t.contributors}
          </Link>
          <Link href={`/${lang}/drivers`} className={`landing-nav-link rounded-[7px] px-[11px] py-2 text-[13px] font-medium max-[760px]:hidden ${active === "drivers" ? "text-landing-ink" : "text-landing-muted"}`}>
            {t.drivers}
          </Link>
          <Link href="https://github.com/t8y2/dbx" target="_blank" aria-label="GitHub" title="GitHub" className="landing-nav-link inline-flex size-9 items-center justify-center rounded-[7px] text-landing-muted max-[760px]:hidden">
            <Github size={18} strokeWidth={2} />
          </Link>
          <Link href={langHref} aria-label={t.langLabel} title={t.langLabel} className="landing-nav-link ml-1.5 inline-flex h-9 items-center justify-center rounded-[7px] border border-landing-line px-2.5 text-[12px] font-[650] tracking-tight text-landing-muted">
            文/A
          </Link>
        </div>
      </div>
    </nav>
  );
}
