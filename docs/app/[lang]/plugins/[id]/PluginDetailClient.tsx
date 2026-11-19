"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, Copy, Download, Package, Zap } from "lucide-react";
import { LandingNav } from "@/components/landing/LandingNav";
import { LandingFooter } from "@/components/landing/LandingFooter";
import type { DocsLang } from "@/lib/i18n";
import { detectPlatformId, type DownloadPlatformId } from "@/lib/platformDetection";
import {
  fetchPluginCatalog,
  formatPluginDate,
  formatPluginSize,
  formatRelativePluginTime,
  latestPluginVersion,
  platformArtifactTarget,
  pluginDisplayDescription,
  pluginDisplayName,
  pluginTargetLabel,
  type MarketplacePlugin,
} from "@/lib/pluginCatalog";

const i18n = {
  en: {
    backToList: "Plugin Center",
    publisher: "Publisher",
    version: "Version",
    license: "License",
    licenseUnknown: "Unlicensed",
    permissionsTitle: "Permissions",
    permissionsCount: (count: number) => `${count} permission${count === 1 ? "" : "s"}`,
    permissionsNote: "Permission codes are granted at install time and shown verbatim from the manifest.",
    installTitle: "Install in DBX",
    installSteps: "Click Install in DBX and confirm in the app. Prefer manual steps? Open the DBX Plugin Center, choose Install from URL, and paste the link for your platform — packages are signature-checked before install.",
    deepLinkInstall: "Install in DBX",
    deepLinkHint: "DBX didn't open? Copy the install URL and paste it in the Plugin Center, or download DBX first.",
    downloadApp: "Download DBX",
    copyUrl: "Copy install URL",
    copied: "Copied",
    downloadShort: "Download",
    download: "Download .dbxp",
    sha256: "SHA-256",
    size: "Size",
    platform: "Platform",
    versionsTitle: "Versions",
    releaseNotes: "Release notes",
    artifacts: "Artifacts",
    sourceRepo: "Source",
    homepage: "Homepage",
    latest: "Latest",
    aboutTitle: "About",
    notFoundTitle: "Plugin not found",
    notFoundDesc: "This plugin is not in the marketplace catalog. It may have been removed, or the link is incorrect.",
    notFoundAction: "Back to Plugin Center",
    loading: "Loading plugin…",
    updatedAgo: (time: string) => `updated ${time}`,
    updatedOn: (time: string) => `updated ${time}`,
  },
  cn: {
    backToList: "插件中心",
    publisher: "发布者",
    version: "版本",
    license: "许可证",
    licenseUnknown: "未声明许可证",
    permissionsTitle: "权限",
    permissionsCount: (count: number) => `${count} 项权限`,
    permissionsNote: "权限代码在安装时授予，此处按 manifest 原文展示。",
    installTitle: "在 DBX 中安装",
    installSteps: "点击“在 DBX 中安装”并在应用中确认即可。也可以手动安装：打开 DBX 插件中心，选择“从 URL 安装”，粘贴对应平台的链接——安装前会校验制品签名。",
    deepLinkInstall: "在 DBX 中安装",
    deepLinkHint: "没有唤起 DBX？可复制安装 URL 到插件中心手动安装，或先下载安装 DBX。",
    downloadApp: "下载 DBX",
    copyUrl: "复制安装 URL",
    copied: "已复制",
    downloadShort: "下载",
    download: "下载 .dbxp",
    sha256: "SHA-256",
    size: "大小",
    platform: "平台",
    versionsTitle: "版本历史",
    releaseNotes: "更新说明",
    artifacts: "安装包",
    sourceRepo: "源码",
    homepage: "主页",
    latest: "最新",
    aboutTitle: "简介",
    notFoundTitle: "未找到该插件",
    notFoundDesc: "该插件不在商店目录中，可能已下架或链接有误。",
    notFoundAction: "返回插件中心",
    loading: "正在加载插件…",
    updatedAgo: (time: string) => `${time}更新`,
    updatedOn: (time: string) => `更新于 ${time}`,
  },
};

type CopyState = "idle" | "copied";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function PluginDetailClient({
  lang,
  id,
  initialPlugin,
}: {
  lang: DocsLang;
  id: string | null;
  initialPlugin: MarketplacePlugin | null;
}) {
  // The static shell route (/plugins/detail) passes id=null and reads ?id= from the
  // worker-rewritten URL; direct [id] pages always pass a concrete id.
  const [resolvedId, setResolvedId] = useState<string | null>(id);
  const [plugin, setPlugin] = useState<MarketplacePlugin | null>(initialPlugin);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">(initialPlugin ? "ready" : "loading");
  const [platformId, setPlatformId] = useState<DownloadPlatformId>("unknown");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [deepLinkMissed, setDeepLinkMissed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const t = i18n[lang];

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!resolvedId && typeof window !== "undefined") {
      setResolvedId(new URLSearchParams(window.location.search).get("id"));
    }
  }, [resolvedId]);

  useEffect(() => {
    detectPlatformId().then((detected) => setPlatformId(detected));
  }, []);

  useEffect(() => {
    if (!resolvedId) return;
    let cancelled = false;
    fetchPluginCatalog({ cache: "no-cache" })
      .then((catalog) => {
        if (cancelled) return;
        const found = catalog?.plugins.find((candidate) => candidate.id === resolvedId) ?? null;
        if (found) {
          setPlugin(found);
          setStatus("ready");
        } else if (!initialPlugin) {
          setStatus("missing");
        }
      })
      .catch(() => {
        if (!cancelled && !initialPlugin) setStatus("missing");
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedId, initialPlugin]);

  const latest = plugin ? latestPluginVersion(plugin) : null;
  const preferredTarget = platformArtifactTarget(platformId);
  const preferredArtifact = useMemo(() => {
    if (!latest) return null;
    return latest.artifacts.find((artifact) => artifact.target === preferredTarget) ?? latest.artifacts[0] ?? null;
  }, [latest, preferredTarget]);

  async function handleCopy() {
    if (!preferredArtifact) return;
    if (await copyText(preferredArtifact.url)) {
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2000);
    }
  }

  // The deep link navigates away via the anchor itself; if the scheme launches
  // (or even just shows the browser's "open app?" prompt) the window loses
  // focus or hides. If neither happens, surface the manual-install fallback.
  function handleDeepLinkInstall() {
    setDeepLinkMissed(false);
    let launched = false;
    const markLaunched = () => {
      launched = true;
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") markLaunched();
    };
    window.addEventListener("blur", markLaunched, { once: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.setTimeout(() => {
      window.removeEventListener("blur", markLaunched);
      document.removeEventListener("visibilitychange", onVisibility);
      if (!launched) setDeepLinkMissed(true);
    }, 2500);
  }

  return (
    <main className="min-h-screen bg-landing-bg text-landing-ink">
      <LandingNav lang={lang} active="plugins" />

      <section className="max-w-[1180px] mx-auto px-6 pt-32 pb-24">
        <Link href={`/${lang}/plugins`} prefetch={false} className="landing-inline-link inline-flex items-center gap-2 text-sm font-[650]">
          <span aria-hidden="true">←</span>
          {t.backToList}
        </Link>

        {status === "loading" && !plugin ? (
          <h1 className="mt-16 text-2xl font-[720] text-landing-muted">{t.loading}</h1>
        ) : !plugin ? (
          <div className="mt-10 rounded-xl border border-landing-line bg-landing-panel p-8 text-center">
            <p className="text-xl font-[720]">{t.notFoundTitle}</p>
            <p className="mt-2 text-sm text-landing-muted">{t.notFoundDesc}</p>
            <Link href={`/${lang}/plugins`} prefetch={false} className="mt-5 inline-flex h-10 items-center rounded-lg bg-[#f0f1f4] px-4 text-[13px] font-[720] text-[#0a0b0e] transition hover:bg-white">
              {t.notFoundAction}
            </Link>
          </div>
        ) : (
          <div className="mt-6">
            <div className="flex flex-wrap items-start gap-5">
              <span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white">
                {plugin.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={plugin.icon} alt="" aria-hidden="true" width={52} height={52} className="size-13 object-contain" />
                ) : (
                  <Package size={28} className="text-[#0a0b0e]" aria-hidden="true" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <h1 className="text-4xl font-[820] tracking-tight">{pluginDisplayName(plugin, lang)}</h1>
                  {latest ? <span className="rounded-md border border-landing-line px-2 py-0.5 text-[12px] font-[650] text-landing-muted">v{latest.version}</span> : null}
                </div>
                <p className="mt-2 text-sm text-landing-muted">
                  <span className="text-landing-ink font-[650]">{plugin.publisher}</span>
                  {plugin.license ? ` · ${plugin.license}` : ""}
                  {latest
                    ? ` · ${
                        mounted
                          ? t.updatedAgo(formatRelativePluginTime(latest.releasedAt, lang))
                          : t.updatedOn(formatPluginDate(latest.releasedAt, lang))
                      }`
                    : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {plugin.source ? (
                  <a href={plugin.source} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-landing-line px-4 text-[13px] font-[650] text-landing-muted transition-colors hover:border-landing-blue hover:text-landing-ink">
                    {t.sourceRepo}
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </a>
                ) : null}
                {plugin.homepage ? (
                  <a href={plugin.homepage} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-landing-line px-4 text-[13px] font-[650] text-landing-muted transition-colors hover:border-landing-blue hover:text-landing-ink">
                    {t.homepage}
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            </div>

            <div className="mt-8 grid grid-cols-1 gap-5 min-[981px]:grid-cols-[minmax(0,1fr)_360px]">
              {/* Right column: description above permissions, sticky while versions scroll.
                  DOM-first so mobile keeps it before the install card. */}
              <div className="flex min-w-0 flex-col gap-5 self-start min-[981px]:sticky min-[981px]:top-24 min-[981px]:col-start-2 min-[981px]:row-start-1">
                <div className="rounded-xl border border-landing-line bg-landing-panel px-6 py-5">
                  <h2 className="text-xl font-[720]">{t.aboutTitle}</h2>
                  <p className="mt-2 text-[14px] leading-[1.8] text-landing-muted">{pluginDisplayDescription(plugin, lang)}</p>
                  {(plugin.tags ?? []).length > 0 ? (
                    <div className="mt-3.5 flex flex-wrap gap-1.5">
                      {(plugin.tags ?? []).map((tag) => (
                        <span key={tag} className="rounded-md bg-landing-soft px-2 py-0.5 text-[11px] font-medium text-landing-muted">
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="rounded-xl border border-landing-line bg-landing-panel px-6 py-5">
                  <h2 className="text-xl font-[720]">{t.permissionsTitle}</h2>
                  <p className="mt-1 text-[12px] text-landing-muted">
                    {plugin.permissions?.length ? t.permissionsCount(plugin.permissions.length) : "—"}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(plugin.permissions ?? []).map((permission) => (
                      <span key={permission} className="rounded-md border border-landing-line bg-landing-soft px-2 py-1 font-mono text-[11px] text-landing-muted">
                        {permission}
                      </span>
                    ))}
                  </div>
                  <p className="mt-4 text-[12px] leading-[1.7] text-landing-muted">{t.permissionsNote}</p>
                </div>
              </div>

              <div className="min-w-0 min-[981px]:col-start-1 min-[981px]:row-start-1">
                {/* Install */}
                <div className="rounded-xl border border-landing-line bg-landing-panel">
                  <div className="border-b border-landing-line px-6 py-5">
                    <h2 className="text-xl font-[720]">{t.installTitle}</h2>
                    <p className="mt-2 max-w-[640px] text-sm leading-[1.7] text-landing-muted">{t.installSteps}</p>
                    {preferredArtifact ? (
                      <div className="mt-4">
                        <div className="flex flex-wrap items-center gap-3">
                          <a
                            href={`dbx://plugins/install?url=${encodeURIComponent(preferredArtifact.url)}`}
                            onClick={handleDeepLinkInstall}
                            className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#f0f1f4] px-4 text-[13px] font-[720] text-[#0a0b0e] transition hover:bg-white"
                          >
                            <Zap size={15} aria-hidden="true" />
                            {t.deepLinkInstall}
                          </a>
                          <button
                            type="button"
                            onClick={handleCopy}
                            className="inline-flex h-10 items-center gap-2 rounded-lg border border-landing-line px-4 text-[13px] font-[650] text-landing-muted transition-colors hover:border-landing-blue hover:text-landing-ink"
                          >
                            {copyState === "copied" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                            {copyState === "copied" ? t.copied : t.copyUrl}
                          </button>
                        </div>
                        {deepLinkMissed ? (
                          <p className="mt-3 text-[12px] leading-[1.7] text-landing-muted">
                            {t.deepLinkHint}{" "}
                            <Link href={`/${lang}`} prefetch={false} className="text-landing-blue transition-colors hover:text-landing-sky">
                              {t.downloadApp}
                            </Link>
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="px-6 py-5">
                    {latest && latest.artifacts.length > 0 ? (
                      <table className="w-full text-left text-[13px]">
                        <thead>
                          <tr className="text-[12px] uppercase tracking-wide text-landing-muted">
                            <th className="py-2 pr-4 font-[650]">{t.platform}</th>
                            <th className="py-2 pr-4 font-[650]">{t.size}</th>
                            <th className="py-2 pr-4 font-[650]">{t.sha256}</th>
                            <th className="py-2 font-[650] sr-only">{t.downloadShort}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {latest.artifacts.map((artifact) => (
                            <tr key={artifact.url} className="border-t border-landing-line">
                              <td className="py-2.5 pr-4 whitespace-nowrap">
                                {artifact.target === preferredArtifact?.target ? (
                                  <span className="font-[650] text-landing-ink">{pluginTargetLabel(artifact.target, lang)}</span>
                                ) : (
                                  <span className="text-landing-muted">{pluginTargetLabel(artifact.target, lang)}</span>
                                )}
                              </td>
                              <td className="py-2.5 pr-4 whitespace-nowrap text-landing-muted">{formatPluginSize(artifact.size)}</td>
                              <td className="py-2.5 pr-4 font-mono text-[11px] text-landing-muted">
                                <span title={artifact.sha256} className="cursor-pointer" onClick={() => copyText(artifact.sha256)}>
                                  {artifact.sha256.slice(0, 16)}…
                                </span>
                              </td>
                              <td className="py-2.5 text-right">
                                <a
                                  href={artifact.url}
                                  aria-label={`${t.download}: ${pluginTargetLabel(artifact.target, lang)}`}
                                  className="inline-flex h-7 items-center gap-1 rounded-md border border-landing-line px-2 text-[11px] font-[650] text-landing-muted transition-colors hover:border-landing-blue hover:text-landing-ink"
                                >
                                  <Download size={12} aria-hidden="true" />
                                  {t.downloadShort}
                                </a>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : null}
                  </div>
                </div>

                {/* Versions */}
                {plugin.versions.length > 0 ? (
                  <div className="mt-5 rounded-xl border border-landing-line bg-landing-panel px-6 py-5">
                    <h2 className="text-xl font-[720]">{t.versionsTitle}</h2>
                    <ul className="mt-5">
                      {plugin.versions.map((version, index) => {
                        const isLatest = version.version === plugin.latestVersion;
                        return (
                          <li
                            key={version.version}
                            className={`relative pb-7 pl-8 last:pb-0 before:absolute before:left-0 before:top-[7px] before:size-[9px] before:rounded-full before:content-[''] ${
                              isLatest ? "before:bg-landing-blue" : "before:bg-landing-muted/50"
                            } ${index < plugin.versions.length - 1 ? "after:absolute after:left-[4px] after:top-[20px] after:bottom-0 after:w-px after:bg-landing-line after:content-['']" : ""}`}
                          >
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span className="font-mono text-[14px] font-[650]">v{version.version}</span>
                              <span className="text-[12px] text-landing-muted">{formatPluginDate(version.releasedAt, lang)}</span>
                              {isLatest ? (
                                <span className="rounded-md border border-landing-line px-1.5 py-0.5 text-[11px] font-[650] text-landing-green">{t.latest}</span>
                              ) : null}
                            </div>
                            {version.releaseNotes ? (
                              <p className="mt-2 max-w-[760px] whitespace-pre-line text-[13px] leading-[1.7] text-landing-muted">{version.releaseNotes}</p>
                            ) : null}
                            {index > 0 && version.artifacts.length > 0 ? (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-[12px] font-[650] text-landing-muted hover:text-landing-ink">{t.artifacts}</summary>
                                <ul className="mt-2 space-y-1.5">
                                  {version.artifacts.map((artifact) => (
                                    <li key={artifact.url} className="flex flex-wrap items-center gap-x-3 text-[12px]">
                                      <span className="text-landing-muted">{pluginTargetLabel(artifact.target, lang)}</span>
                                      <span className="text-landing-muted">{formatPluginSize(artifact.size)}</span>
                                      <a href={artifact.url} className="landing-inline-link font-[650]">
                                        {t.download}
                                      </a>
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </section>

      <LandingFooter lang={lang} />
    </main>
  );
}
