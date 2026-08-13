"use client";

import { ChevronDown, Download, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createInstallOptions } from "@/lib/downloadLinks";

type InstallTabsProps = {
  lang: "en" | "cn";
  version: string;
};

const downloadLabel = { en: "Download DBX", cn: "下载 DBX" };
const offlineHint = {
  en: "Offline network or Windows 7? Choose an offline installer",
  cn: "无法联网或使用 Windows 7？选择专用离线安装包",
};

const platformIconPaths = {
  dark: {
    "linux-arm": "/icons/platform/linux.svg",
    linux: "/icons/platform/linux.svg",
    "macos-arm": "/icons/platform/macos.png",
    "macos-intel": "/icons/platform/macos.png",
    windows: "/icons/platform/windows.png",
  },
  light: {
    "linux-arm": "/icons/platform/linux.svg",
    linux: "/icons/platform/linux.svg",
    "macos-arm": "/icons/platform/macos-white.png",
    "macos-intel": "/icons/platform/macos-white.png",
    windows: "/icons/platform/windows.png",
  },
};

function detectPlatformId(): string {
  if (typeof navigator === "undefined") return "macos-arm";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux")) return ua.includes("aarch64") || ua.includes("arm") ? "linux-arm" : "linux";
  return "macos-arm";
}

function PlatformIcon({ id, size, variant }: { id: string; size: number; variant: "dark" | "light" }) {
  const src = platformIconPaths[variant][id as keyof (typeof platformIconPaths)["dark"]];
  if (!src) return <Server size={size} />;
  return <img alt="" aria-hidden="true" height={size} src={src} width={size} />;
}

export function InstallTabs({ lang, version }: InstallTabsProps) {
  const options = useMemo(() => createInstallOptions(lang, version), [lang, version]);
  const [open, setOpen] = useState(false);
  const [platformId, setPlatformId] = useState("macos-arm");

  useEffect(() => {
    setPlatformId(detectPlatformId());
  }, []);

  useEffect(() => {
    if (!open) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const primary = useMemo(() => options.find((o) => o.id === platformId) ?? options[0], [options, platformId]);
  const menuOptions = useMemo(
    () => options.filter((option) => option.id !== primary.id).sort((a, b) => Number(b.iconId === primary.iconId) - Number(a.iconId === primary.iconId)),
    [options, primary],
  );

  return (
    <div
      className="landing-install relative z-20 block w-fit max-w-full mx-auto"
      data-open={open}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <div className="landing-install-control relative">
        <div className="landing-install-trigger grid grid-cols-[minmax(0,1fr)_52px] items-stretch w-[min(340px,calc(100vw-36px))] min-h-[68px] border-0 rounded-full mx-auto overflow-hidden">
          <a className="landing-install-primary grid grid-cols-[auto_minmax(0,1fr)] gap-4 items-center min-w-0 px-6 max-[360px]:gap-3 max-[360px]:px-5" href={primary.href}>
            <PlatformIcon id={primary.iconId} size={30} variant="dark" />
            <span className="grid gap-0.5 min-w-0 text-left">
              <strong className="overflow-hidden text-[15px] font-[780] leading-[1.2] truncate">{downloadLabel[lang]}</strong>
              <small className="overflow-hidden text-xs font-[520] leading-tight truncate text-[color-mix(in_srgb,#0f172a_48%,#94a3b8)]">{primary.label}</small>
            </span>
          </a>
          <button
            type="button"
            aria-controls="landing-install-menu"
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label={lang === "cn" ? "显示其他下载选项" : "Show other download options"}
            className="landing-install-toggle grid place-items-center border-0 border-l border-l-[rgba(15,23,42,0.12)] bg-transparent text-[#5f6876] cursor-pointer"
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDown size={18} />
          </button>
        </div>
        <div
          className="landing-install-menu absolute z-30 top-[calc(100%+12px)] left-1/2 -translate-x-1/2 grid w-[min(380px,calc(100vw-32px))] border border-[rgba(155,176,205,0.17)] rounded-xl py-1.5 max-[760px]:left-auto max-[760px]:translate-x-0"
          id="landing-install-menu"
          role="menu"
          aria-label={lang === "cn" ? "下载选项" : "Download options"}
        >
          {menuOptions.map((item) => (
            <a className="landing-install-option grid grid-cols-[24px_minmax(0,1fr)_18px] gap-3 items-center min-h-11 min-w-0 border-0 px-[18px] py-3 bg-transparent text-left cursor-pointer" href={item.href} key={item.id} role="menuitem">
              <PlatformIcon id={item.iconId} size={20} variant="light" />
              <span className="grid min-w-0 gap-1">
                <span className="flex min-w-0 items-center gap-2">
                  <strong className="overflow-hidden text-sm font-[640] leading-[1.2] truncate">{item.label}</strong>
                  {item.badge ? <small className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-[680] leading-none text-white/70">{item.badge}</small> : null}
                </span>
                {item.description ? <small className="overflow-hidden text-xs leading-[1.3] text-white/45 truncate">{item.description}</small> : null}
              </span>
              <Download size={15} aria-hidden="true" />
            </a>
          ))}
        </div>
      </div>
      {platformId === "windows" && !open ? (
        <button
          type="button"
          aria-controls="landing-install-menu"
          className="mt-3 w-[min(340px,calc(100vw-36px))] border-0 bg-transparent px-2 text-center text-xs leading-relaxed text-[color-mix(in_srgb,var(--color-landing-ink)_62%,var(--color-landing-muted))] underline decoration-[color-mix(in_srgb,var(--color-landing-muted)_48%,transparent)] underline-offset-4 cursor-pointer hover:text-[var(--color-landing-ink)]"
          onClick={() => setOpen(true)}
        >
          {offlineHint[lang]}
        </button>
      ) : null}
    </div>
  );
}
