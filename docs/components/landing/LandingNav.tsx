"use client";

import Link from "next/link";
import { Github, Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DocsLang } from "@/lib/i18n";

// Order of the nav language button, which cycles rather than toggling: with
// three locales a two-way "other language" switch would strand Turkish
// readers on the Chinese site.
const LANG_CYCLE = ["en", "cn", "tr"] as const satisfies readonly DocsLang[];
const LANG_BUTTON_LABEL: Record<DocsLang, string> = { en: "EN", cn: "中", tr: "TR" };

const i18n = {
  en: {
    home: "Home",
    docs: "Docs",
    changelog: "Changelog",
    community: "Community",
    sponsors: "Sponsors",
    contributors: "Contributors",
    drivers: "Offline Drivers",
    langLabel: "Switch language",
    menu: "Open navigation",
    closeMenu: "Close navigation",
    navLabel: "Primary navigation",
  },
  tr: {
    home: "Ana Sayfa",
    docs: "Dokümanlar",
    changelog: "Değişiklik Günlüğü",
    community: "Topluluk",
    sponsors: "Sponsorlar",
    contributors: "Katkıda Bulunanlar",
    drivers: "Çevrimdışı Sürücüler",
    langLabel: "Dili değiştir",
    menu: "Gezinmeyi aç",
    closeMenu: "Gezinmeyi kapat",
    navLabel: "Ana gezinme",
  },
  cn: {
    home: "首页",
    docs: "文档",
    changelog: "更新日志",
    community: "交流群",
    sponsors: "赞助商",
    contributors: "贡献者",
    drivers: "离线驱动",
    langLabel: "切换语言",
    menu: "打开导航",
    closeMenu: "关闭导航",
    navLabel: "主导航",
  },
};

export function LandingNav({ lang, active }: { lang: DocsLang; active?: "home" | "databases" | "changelog" | "community" | "issue" | "sponsors" | "contributors" | "drivers" }) {
  const ref = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const t = i18n[lang];
  const otherLang = LANG_CYCLE[(LANG_CYCLE.indexOf(lang) + 1) % LANG_CYCLE.length];
  const langHrefMap: Record<string, string> = {
    databases: `/${otherLang}/databases`,
    changelog: `/${otherLang}/changelog`,
    community: `/${otherLang}/community`,
    issue: `/${otherLang}/issue`,
    sponsors: `/${otherLang}/sponsors`,
    contributors: `/${otherLang}/contributors`,
    drivers: `/${otherLang}/drivers`,
  };
  const langHref = langHrefMap[active ?? ""] ?? `/${otherLang}`;
  const navItems = [
    { id: "home", href: `/${lang}`, label: t.home, tabletHidden: false },
    { id: "docs", href: `/${lang}/docs/what-is-dbx`, label: t.docs, tabletHidden: false },
    { id: "changelog", href: `/${lang}/changelog`, label: t.changelog, tabletHidden: false },
    { id: "community", href: `/${lang}/community`, label: t.community, tabletHidden: false },
    { id: "sponsors", href: `/${lang}/sponsors`, label: t.sponsors, tabletHidden: true },
    { id: "contributors", href: `/${lang}/contributors`, label: t.contributors, tabletHidden: true },
    { id: "drivers", href: `/${lang}/drivers`, label: t.drivers, tabletHidden: false },
  ] as const;

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

  useEffect(() => {
    if (!menuOpen) return;

    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const closeOnDesktop = () => {
      if (window.innerWidth > 760) setMenuOpen(false);
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnDesktop);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnDesktop);
    };
  }, [menuOpen]);

  return (
    <nav ref={ref} className={`landing-nav${menuOpen ? " is-menu-open" : ""}`} aria-label={t.navLabel}>
      <div className="landing-nav-inner flex items-center justify-between max-w-[1180px] h-16 mx-auto px-7 max-[760px]:min-h-[60px] max-[760px]:h-auto max-[760px]:px-[18px] max-[760px]:py-2">
        <Link href={`/${lang}`} prefetch={false} className="landing-nav-brand flex min-h-11 items-center gap-2.5 text-landing-ink text-2xl font-[820]" onClick={() => setMenuOpen(false)}>
          <img src="/logo-64.png" alt="" aria-hidden="true" width={28} height={28} />
          <span>DBX</span>
        </Link>
        <div className="flex items-center gap-1">
          {navItems.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              prefetch={false}
              aria-current={active === item.id ? "page" : undefined}
              className={`landing-nav-link inline-flex h-9 items-center rounded-[7px] px-[10px] text-[13px] font-medium max-[760px]:hidden ${item.tabletHidden ? "max-[900px]:hidden" : ""} ${active === item.id ? "text-landing-ink" : "text-landing-muted"}`}
            >
              {item.label}
            </Link>
          ))}
          <Link href="https://github.com/t8y2/dbx" target="_blank" rel="noopener noreferrer" aria-label="GitHub" title="GitHub" className="landing-nav-link inline-flex size-9 items-center justify-center rounded-[7px] text-landing-muted max-[760px]:hidden">
            <Github size={18} strokeWidth={2} />
          </Link>
          <Link href={langHref} prefetch={false} aria-label={t.langLabel} title={t.langLabel} className="landing-nav-link ml-1.5 inline-flex h-9 items-center justify-center rounded-[7px] border border-landing-line px-3 text-[12px] font-[650] tracking-tight text-landing-muted" onClick={() => setMenuOpen(false)}>
            {LANG_BUTTON_LABEL[otherLang]}
          </Link>
          <button
            type="button"
            className="landing-nav-link ml-1 inline-flex size-11 items-center justify-center rounded-[7px] border border-landing-line text-landing-ink min-[761px]:hidden"
            aria-controls="landing-mobile-menu"
            aria-expanded={menuOpen}
            aria-label={menuOpen ? t.closeMenu : t.menu}
            onClick={() => setMenuOpen((current) => !current)}
          >
            {menuOpen ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
      </div>
      <div id="landing-mobile-menu" className="landing-mobile-menu min-[761px]:hidden" data-open={menuOpen} aria-hidden={!menuOpen}>
        <button type="button" className="landing-mobile-menu-backdrop" aria-label={t.closeMenu} tabIndex={menuOpen ? 0 : -1} onClick={() => setMenuOpen(false)} />
        <div className="landing-mobile-menu-panel">
          {navItems.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              prefetch={false}
              aria-current={active === item.id ? "page" : undefined}
              className="landing-mobile-menu-link"
              onClick={() => setMenuOpen(false)}
              tabIndex={menuOpen ? 0 : -1}
            >
              <span>{item.label}</span>
              <span aria-hidden="true">→</span>
            </Link>
          ))}
          <Link href="https://github.com/t8y2/dbx" target="_blank" rel="noopener noreferrer" className="landing-mobile-menu-link" onClick={() => setMenuOpen(false)} tabIndex={menuOpen ? 0 : -1}>
            <span className="inline-flex items-center gap-2"><Github size={17} /> GitHub</span>
            <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </div>
    </nav>
  );
}
