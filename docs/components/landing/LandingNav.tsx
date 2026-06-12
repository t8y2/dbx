"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

const i18n = {
  en: {
    home: "Home",
    docs: "Docs",
    databases: "Databases",
    changelog: "Changelog",
    community: "Community",
    drivers: "Offline Drivers",
    lang: "中文",
  },
  cn: { home: "首页", docs: "文档", databases: "数据库", changelog: "更新日志", community: "交流群", drivers: "离线驱动", lang: "English" },
};

export function LandingNav({ lang, active }: { lang: "en" | "cn"; active?: "home" | "databases" | "changelog" | "community" | "drivers" }) {
  const ref = useRef<HTMLElement>(null);
  const t = i18n[lang];
  const otherLang = lang === "cn" ? "en" : "cn";
  const langHrefMap: Record<string, string> = {
    databases: `/${otherLang}/databases`,
    changelog: `/${otherLang}/changelog`,
    community: `/${otherLang}/community`,
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
          <Link href={`/${lang}/databases`} className={`landing-nav-link rounded-[7px] px-[11px] py-2 text-[13px] font-medium max-[760px]:hidden ${active === "databases" ? "text-landing-ink" : "text-landing-muted"}`}>
            {t.databases}
          </Link>
          <Link href={`/${lang}/changelog`} className={`landing-nav-link rounded-[7px] px-[11px] py-2 text-[13px] font-medium max-[760px]:hidden ${active === "changelog" ? "text-landing-ink" : "text-landing-muted"}`}>
            {t.changelog}
          </Link>
          <Link href={`/${lang}/community`} className={`landing-nav-link rounded-[7px] px-[11px] py-2 text-[13px] font-medium max-[760px]:hidden ${active === "community" ? "text-landing-ink" : "text-landing-muted"}`}>
            {t.community}
          </Link>
          <Link href={`/${lang}/drivers`} className={`landing-nav-link rounded-[7px] px-[11px] py-2 text-[13px] font-medium max-[760px]:hidden ${active === "drivers" ? "text-landing-ink" : "text-landing-muted"}`}>
            {t.drivers}
          </Link>
          <Link href="https://github.com/t8y2/dbx" target="_blank" className="landing-nav-link rounded-[7px] px-[11px] py-2 text-landing-muted text-[13px] font-medium max-[760px]:hidden">
            GitHub
          </Link>
          <Link href={langHref} className="landing-nav-link rounded-[7px] px-[11px] py-2 text-landing-muted text-[13px] font-medium ml-1.5 border border-landing-line">
            {t.lang}
          </Link>
        </div>
      </div>
    </nav>
  );
}
