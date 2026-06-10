"use client";

import { ChevronDown, Download, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createInstallOptions, type InstallOption } from "@/lib/downloadLinks";
import { fetchLatestReleaseInfo } from "@/lib/latestRelease";

type InstallTabsProps = {
  lang: "en" | "cn";
  version: string;
};

const downloadLabel = { en: "Download DBX", cn: "下载 DBX" };

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
  const [downloadVersion, setDownloadVersion] = useState(version);
  const options = useMemo(() => createInstallOptions(lang, downloadVersion), [lang, downloadVersion]);
  const [open, setOpen] = useState(false);
  const [platformId, setPlatformId] = useState("macos-arm");

  useEffect(() => {
    setPlatformId(detectPlatformId());
  }, []);

  useEffect(() => {
    let active = true;

    setDownloadVersion(version);
    fetchLatestReleaseInfo().then((release) => {
      if (active && release?.version) {
        setDownloadVersion(release.version);
      }
    });

    return () => {
      active = false;
    };
  }, [version]);

  const primary = useMemo(() => options.find((o) => o.id === platformId) ?? options[0], [options, platformId]);
  const menuOptions = useMemo(() => options.filter((o) => o.id !== platformId), [options, platformId]);

  return (
    <div
      className="landing-install relative z-20 block w-fit max-w-full mx-auto"
      data-open={open}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <a
        aria-controls="landing-install-menu"
        aria-expanded={open}
        aria-haspopup="listbox"
        className="landing-install-trigger grid grid-cols-[auto_minmax(0,1fr)_auto] gap-4 items-center w-[min(340px,calc(100vw-48px))] min-h-[68px] border-0 rounded-full mx-auto px-6 cursor-pointer"
        href={primary.href}
        onFocus={() => setOpen(true)}
      >
        <PlatformIcon id={primary.id} size={30} variant="dark" />
        <span className="grid gap-0.5 min-w-0">
          <strong className="overflow-hidden text-[15px] font-[780] leading-[1.2] truncate">{downloadLabel[lang]}</strong>
          <small className="overflow-hidden text-xs font-[520] leading-tight truncate text-[color-mix(in_srgb,#0f172a_48%,#94a3b8)]">{primary.label}</small>
        </span>
        <ChevronDown size={18} />
      </a>
      <div
        className="landing-install-menu absolute z-30 top-[calc(100%+12px)] left-1/2 -translate-x-1/2 grid w-[min(300px,calc(100vw-48px))] border border-[rgba(155,176,205,0.17)] rounded-xl py-1.5"
        id="landing-install-menu"
        role="listbox"
        aria-label={lang === "cn" ? "下载选项" : "Download options"}
      >
        {menuOptions.map((item) => (
          <a aria-selected="false" className="landing-install-option grid grid-cols-[24px_minmax(0,1fr)_18px] gap-3 items-center min-w-0 border-0 px-[18px] py-3 bg-transparent text-left cursor-pointer" href={item.href} key={item.id} role="option">
            <PlatformIcon id={item.id} size={20} variant="light" />
            <strong className="overflow-hidden text-sm font-[640] leading-[1.2] truncate">{item.label}</strong>
            <Download size={15} aria-hidden="true" />
          </a>
        ))}
      </div>
    </div>
  );
}
