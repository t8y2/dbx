"use client";

import { Check, ChevronDown, ChevronRight, Copy, Download, Server, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createInstallOptions, type InstallOption } from "@/lib/downloadLinks";
import { detectPlatformId, type DownloadPlatformId } from "@/lib/platformDetection";
import type { DocsLang } from "@/lib/i18n";

type InstallTabsProps = {
  lang: DocsLang;
  version: string;
};

const downloadLabel = { en: "Download DBX", cn: "下载 DBX", tr: "DBX'i indir" };
const selectDownloadLabel = { en: "Choose a version", cn: "选择下载版本", tr: "Bir sürüm seçin" };
const selectMacLabel = { en: "Choose a macOS version", cn: "选择 macOS 版本", tr: "macOS sürümü seçin" };
const offlineHint = {
  en: "Installing offline or using legacy Windows? View the matching installer",
  cn: "需要离线安装或使用旧版 Windows？查看对应安装包",
  tr: "Çevrimdışı mı kuruyorsunuz ya da eski bir Windows mu kullanıyorsunuz? Uygun yükleyiciye bakın",
};

const browserStaticText = {
  en: {
    eyebrow: "Linux browser package",
    intro: "For Kylin, UnionTech UOS, and other Linux distributions. DBX runs locally and opens in your browser.",
    extract: "Extract and enter the package directory",
    start: "Start DBX",
    open: "Open in your local browser",
    port: "Need a different port?",
    portHint: "Replace 8080 with any available local port.",
    browserStyle: "Page layout looks incorrect?",
    browserStyleHint: [
      "Some browsers in intranet or enterprise Linux environments use older browser engines that may not fully support the modern web standards used by DBX, resulting in missing or incorrect styles.",
      "For example, older QiAnXin browser versions based on Chromium 90 can show this behavior.",
      "Update the browser to its latest version, or use a current version of Chrome, Edge, or Firefox.",
    ],
    download: "Download",
    close: "Close installation guide",
    copy: "Copy command",
    copied: "Copied",
  },
  tr: {
    eyebrow: "Linux tarayıcı paketi",
    intro: "Kylin, UnionTech UOS ve diğer Linux dağıtımları içindir. DBX yerelde çalışır ve tarayıcınızda açılır.",
    extract: "Arşivi açın ve paket dizinine girin",
    start: "DBX'i başlatın",
    open: "Yerel tarayıcınızda açın",
    port: "Farklı bir port mu gerekiyor?",
    portHint: "8080 yerine kullanılabilir başka bir yerel port yazın.",
    browserStyle: "Sayfa düzeni bozuk mu görünüyor?",
    browserStyleHint: [
      "İç ağ veya kurumsal Linux ortamlarındaki bazı tarayıcılar, DBX'in kullandığı modern web standartlarını tam desteklemeyen eski tarayıcı motorları kullanır; bu da eksik veya hatalı biçimlendirmeye yol açar.",
      "Örneğin Chromium 90 tabanlı eski QiAnXin tarayıcı sürümlerinde bu davranış görülebilir.",
      "Tarayıcıyı en son sürümüne güncelleyin ya da güncel bir Chrome, Edge veya Firefox sürümü kullanın.",
    ],
    download: "İndir",
    close: "Kurulum kılavuzunu kapat",
    copy: "Komutu kopyala",
    copied: "Kopyalandı",
  },
  cn: {
    eyebrow: "Linux 浏览器版",
    intro: "适用于麒麟、统信 UOS 等 Linux 发行版。DBX 在本机运行，通过浏览器访问。",
    extract: "解压并进入安装目录",
    start: "启动 DBX",
    open: "在本机浏览器打开",
    port: "需要修改默认端口？",
    portHint: "将 8080 替换为其他可用端口即可。",
    browserStyle: "网页样式显示异常？",
    browserStyleHint: ["部分信创或内网环境使用的浏览器内核版本较旧，可能无法完整支持 DBX 使用的现代 Web 标准，从而出现布局错位、样式缺失等问题。", "例如，基于 Chromium 90 内核的旧版奇安信浏览器可能出现此类情况。", "请优先升级当前浏览器；环境允许时，也可以改用新版 Chrome、Edge 或 Firefox。"],
    download: "下载",
    close: "关闭安装说明",
    copy: "复制命令",
    copied: "已复制",
  },
};

const INSTALL_ARIA: Record<DocsLang, { moreOptions: string; options: string; guide: (label: string) => string; download: (label: string) => string }> = {
  en: {
    moreOptions: "Show other download options",
    options: "Download options",
    guide: (label) => `View installation guide for ${label}`,
    download: (label) => `Download ${label}`,
  },
  cn: {
    moreOptions: "显示其他下载选项",
    options: "下载选项",
    guide: (label) => `查看 ${label} 安装说明`,
    download: (label) => `下载 ${label}`,
  },
  tr: {
    moreOptions: "Diğer indirme seçeneklerini göster",
    options: "İndirme seçenekleri",
    guide: (label) => `${label} kurulum kılavuzunu görüntüle`,
    download: (label) => `${label} indir`,
  },
};

const platformIconPaths = {
  dark: {
    "linux-arm": "/icons/platform/linux.svg",
    linux: "/icons/platform/linux.svg",
    "macos-arm": "/icons/platform/macos.png",
    "macos-intel": "/icons/platform/macos.png",
    "macos-unknown": "/icons/platform/macos.png",
    windows: "/icons/platform/windows.png",
    "windows-legacy": "/icons/platform/windows-legacy.png",
  },
  light: {
    "linux-arm": "/icons/platform/linux.svg",
    linux: "/icons/platform/linux.svg",
    "macos-arm": "/icons/platform/macos-white.png",
    "macos-intel": "/icons/platform/macos-white.png",
    "macos-unknown": "/icons/platform/macos-white.png",
    windows: "/icons/platform/windows.png",
    "windows-legacy": "/icons/platform/windows-legacy.png",
  },
};

function PlatformIcon({ id, size, variant }: { id: string; size: number; variant: "dark" | "light" }) {
  const src = platformIconPaths[variant][id as keyof (typeof platformIconPaths)["dark"]];
  if (!src) return <Server size={size} />;
  return <img alt="" aria-hidden="true" height={size} src={src} width={size} />;
}

function BrowserStaticDialog({ lang, option, version, onClose }: { lang: DocsLang; option: InstallOption; version: string; onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const text = browserStaticText[lang];
  const archiveName = `DBX_${version}_*-browser-static.tar.gz`;
  const packageDirectory = "dbx-linux-*-browser-static";
  const extractCommand = `tar -xzf ${archiveName}\ncd ${packageDirectory}`;
  const downloads = option.browserStaticDownloads ?? [{ arch: "x64" as const, href: option.href }];

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  const copyCommand = (command: string) => {
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopiedCommand(command);
        window.setTimeout(() => setCopiedCommand((current) => (current === command ? null : current)), 1600);
      })
      .catch(() => undefined);
  };

  const commandBlock = (command: string) => (
    <div className="grid grid-cols-[minmax(0,1fr)_34px] items-start gap-2 rounded-md border border-white/10 bg-black/30 p-2 pl-3">
      <code className="min-w-0 overflow-x-auto whitespace-pre font-mono text-xs leading-relaxed text-[#dce5ee]">{command}</code>
      <button
        type="button"
        aria-label={copiedCommand === command ? text.copied : text.copy}
        className="grid size-[34px] place-items-center rounded-md border-0 bg-white/[0.06] text-white/65 cursor-pointer hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
        title={copiedCommand === command ? text.copied : text.copy}
        onClick={() => copyCommand(command)}
      >
        {copiedCommand === command ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] grid place-items-center overflow-y-auto bg-black/70 px-4 py-6 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section aria-labelledby="browser-static-dialog-title" aria-modal="true" className="w-[min(560px,calc(100vw-32px))] max-h-[calc(100vh-48px)] overflow-y-auto rounded-lg border border-white/15 bg-[#111419] text-white shadow-[0_28px_90px_rgba(0,0,0,0.58)]" role="dialog">
        <header className="grid grid-cols-[minmax(0,1fr)_36px] gap-4 border-b border-white/10 px-5 py-4">
          <div className="min-w-0">
            <small className="text-[11px] font-semibold text-[#69c9ff]">{text.eyebrow}</small>
            <h2 className="mt-1 text-lg font-semibold leading-tight" id="browser-static-dialog-title">
              {option.label}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-white/55">{text.intro}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label={text.close}
            className="grid size-9 place-items-center rounded-md border-0 bg-white/[0.06] text-white/65 cursor-pointer hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
            title={text.close}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        <div className="grid gap-4 px-5 py-4">
          <section>
            <h3 className="mb-2 text-sm font-semibold">1. {text.extract}</h3>
            {commandBlock(extractCommand)}
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">2. {text.start}</h3>
            {commandBlock("./dbx")}
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">3. {text.open}</h3>
            <a className="inline-flex text-sm font-semibold text-[#69c9ff] underline underline-offset-4 hover:text-[#9dddff]" href="http://127.0.0.1:4224" target="_blank" rel="noreferrer">
              http://127.0.0.1:4224
            </a>
          </section>
          <details className="group border-t border-white/10 pt-3">
            <summary className="w-fit cursor-pointer text-xs font-medium text-white/45 hover:text-white/70 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/60">{text.port}</summary>
            <div className="mt-3">
              {commandBlock("DBX_PORT=8080 ./dbx")}
              <p className="mt-2 text-xs leading-relaxed text-white/45">{text.portHint}</p>
            </div>
          </details>
          <details className="group border-t border-white/10 pt-3">
            <summary className="w-fit cursor-pointer text-xs font-medium text-white/45 hover:text-white/70 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/60">{text.browserStyle}</summary>
            <div className="mt-3 grid gap-2 text-xs leading-relaxed text-white/55">
              {text.browserStyleHint.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </details>
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-white/10 px-5 py-4">
          {downloads.map((download) => (
            <a className="inline-flex min-h-10 items-center gap-2 rounded-md bg-white px-4 text-sm font-semibold text-[#111419] hover:bg-[#e9f5fb] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#69c9ff]" href={download.href} key={download.arch}>
              <Download size={16} />
              {text.download} {download.arch === "arm64" ? "ARM64" : "x64"}
            </a>
          ))}
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function InstallTabs({ lang, version }: InstallTabsProps) {
  const options = useMemo(() => createInstallOptions(lang, version), [lang, version]);
  const [open, setOpen] = useState(false);
  const [platformId, setPlatformId] = useState<DownloadPlatformId>("unknown");
  const [browserStaticOption, setBrowserStaticOption] = useState<InstallOption | null>(null);
  const closeBrowserStaticDialog = useCallback(() => setBrowserStaticOption(null), []);

  useEffect(() => {
    let cancelled = false;

    void detectPlatformId(navigator).then((detectedPlatformId) => {
      if (!cancelled) setPlatformId(detectedPlatformId);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const primary = useMemo(() => options.find((option) => option.id === platformId), [options, platformId]);
  const menuOptions = useMemo(() => {
    if (!primary) return options;
    return options.filter((option) => option.id !== primary.id).sort((a, b) => Number(b.iconId === primary.iconId) - Number(a.iconId === primary.iconId));
  }, [options, primary]);
  const fallbackIconId = platformId === "macos-unknown" ? "macos-unknown" : "unknown";
  const fallbackLabel = platformId === "macos-unknown" ? selectMacLabel[lang] : selectDownloadLabel[lang];
  const primaryContent = (
    <>
      <PlatformIcon id={primary?.iconId ?? fallbackIconId} size={30} variant="dark" />
      <span className="grid gap-0.5 min-w-0 text-left">
        <strong className="overflow-hidden text-[15px] font-[780] leading-[1.2] truncate">{downloadLabel[lang]}</strong>
        <small className="overflow-hidden text-xs font-[520] leading-tight truncate text-[color-mix(in_srgb,#121315_48%,#9aa0a8)]">{primary?.label ?? fallbackLabel}</small>
      </span>
    </>
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
          {primary ? (
            <a className="landing-install-primary grid grid-cols-[auto_minmax(0,1fr)] gap-4 items-center min-w-0 px-6 max-[360px]:gap-3 max-[360px]:px-5" href={primary.href}>
              {primaryContent}
            </a>
          ) : (
            <button
              type="button"
              aria-controls="landing-install-menu"
              aria-expanded={open}
              aria-haspopup="menu"
              className="landing-install-primary grid grid-cols-[auto_minmax(0,1fr)] gap-4 items-center min-w-0 border-0 bg-transparent px-6 cursor-pointer max-[360px]:gap-3 max-[360px]:px-5"
              onClick={() => setOpen(true)}
            >
              {primaryContent}
            </button>
          )}
          <button
            type="button"
            aria-controls="landing-install-menu"
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label={INSTALL_ARIA[lang].moreOptions}
            className="landing-install-toggle grid place-items-center border-0 border-l border-l-[rgba(10,11,13,0.12)] bg-transparent text-[#6a6f78] cursor-pointer"
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDown size={18} />
          </button>
        </div>
        <div
          className="landing-install-menu absolute z-30 top-[calc(100%+12px)] left-1/2 -translate-x-1/2 grid max-h-[min(680px,calc(100vh-140px))] w-[min(410px,calc(100vw-32px))] overflow-y-auto overscroll-contain border border-[rgba(173,176,182,0.17)] rounded-xl py-1.5 max-[760px]:left-auto max-[760px]:translate-x-0"
          id="landing-install-menu"
          role="menu"
          aria-label={INSTALL_ARIA[lang].options}
        >
          {menuOptions.map((item) => (
            <div className="landing-install-option relative grid grid-cols-[24px_minmax(0,1fr)_18px] gap-3 items-center min-h-11 min-w-0 border-0 px-[18px] py-3 bg-transparent text-left cursor-pointer" key={item.id} role="none">
              {item.action === "instructions" ? (
                <button
                  type="button"
                  aria-label={INSTALL_ARIA[lang].guide(item.label)}
                  className="landing-install-download-link absolute inset-0 border-0 bg-transparent cursor-pointer"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    setBrowserStaticOption(item);
                  }}
                />
              ) : (
                <a aria-label={INSTALL_ARIA[lang].download(item.label)} className="landing-install-download-link absolute inset-0" href={item.href} role="menuitem" />
              )}
              <PlatformIcon id={item.iconId} size={20} variant="light" />
              <span className="grid min-w-0 gap-1">
                <span className="flex min-w-0 items-start gap-2">
                  <strong className="min-w-0 text-sm font-[640] leading-[1.2]">{item.label}</strong>
                  {item.badge ? <small className={`shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-[680] leading-none text-white/70 ${item.id === "windows-7-offline" ? "max-[400px]:hidden" : ""}`}>{item.badge}</small> : null}
                </span>
                {item.description ? (
                  <small className="pointer-events-none text-xs leading-[1.35] text-white/45">
                    {item.description}
                    {item.driverLinkLabel ? (
                      <>
                        {lang === "en" ? " " : null}
                        <a className="landing-install-driver-link pointer-events-auto relative z-10 underline underline-offset-2" href={`/${lang}/drivers`}>
                          {item.driverLinkLabel}
                        </a>
                      </>
                    ) : null}
                    {item.descriptionSuffix}
                  </small>
                ) : null}
              </span>
              {item.action === "instructions" ? <ChevronRight size={15} aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
            </div>
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
      {browserStaticOption ? <BrowserStaticDialog lang={lang} option={browserStaticOption} version={version} onClose={closeBrowserStaticDialog} /> : null}
    </div>
  );
}
