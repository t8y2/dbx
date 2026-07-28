import Link from "next/link";

const i18n = {
  en: {
    tagline: "20 MB to manage 70+ databases.",
    copyright: `© ${new Date().getFullYear()} DBX. All rights reserved.`,
  },
  cn: {
    tagline: "20MB，管理70+种数据库。",
    copyright: `© ${new Date().getFullYear()} DBX.`,
  },
};

function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="size-[18px]">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

export function LandingFooter({ lang }: { lang: "en" | "cn" }) {
  const t = i18n[lang];

  return (
    <footer className="border-t border-[var(--color-landing-line)] bg-[#0b1120]">
      <div className="max-w-[1180px] mx-auto px-7 py-7 max-[760px]:px-[18px]">
        <div className="flex items-center justify-between gap-4 max-[760px]:flex-col max-[760px]:gap-3 max-[760px]:text-center">
          {/* Logo */}
          <Link href={`/${lang}`} className="flex items-center gap-2.5 text-[var(--color-landing-ink)] text-lg font-[820] shrink-0">
            <img src="/logo.png" alt="DBX" width={22} height={22} />
            <span>DBX</span>
          </Link>

          {/* Tagline */}
          <span className="text-[13px] text-[var(--color-landing-muted)]">{t.tagline}</span>

          {/* Repo icons */}
          <div className="flex items-center gap-3 shrink-0">
            <a href="https://github.com/t8y2/dbx" target="_blank" rel="noopener noreferrer" className="text-[var(--color-landing-muted)] hover:text-[var(--color-landing-ink)] transition-colors" aria-label="GitHub">
              <GithubIcon />
            </a>
            <a href="https://cnb.cool/dbxio.com/dbx" target="_blank" rel="noopener noreferrer" className="opacity-40 hover:opacity-100 transition-opacity" aria-label="CNB">
              <img src="/icons/cnb.svg" alt="CNB" width={18} height={18} />
            </a>
            <a href="https://atomgit.com/t8y2/dbx" target="_blank" rel="noopener noreferrer" className="opacity-40 hover:opacity-100 transition-opacity" aria-label="AtomGit">
              <img src="/icons/atomgit.png" alt="AtomGit" width={18} height={18} />
            </a>
          </div>

          {/* Copyright */}
          <span className="text-[12px] text-[var(--color-landing-muted)] shrink-0">{t.copyright}</span>
        </div>
      </div>
    </footer>
  );
}
