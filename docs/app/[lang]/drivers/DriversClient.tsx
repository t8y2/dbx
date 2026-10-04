"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { LandingNav } from "@/components/landing/LandingNav";
import { LandingSelect } from "@/components/landing/LandingSelect";
import { downloadLinksFor, formatSize, platformLabels, type AgentDownloadCatalog, type AgentRegistry, type DownloadSource, type JreDisplayEntry, type NativeAgentDisplayEntry, type OfflineBundleEntry } from "@/lib/agentRegistry";
import { assembleCustomBundle, buildCustomBundleOptions, cnbMirrorUrl, computeBundlePlan, CUSTOM_BUNDLE_PLATFORMS, proxyUrl, resolveBundleJre, type BundleProgress } from "@/lib/agentBundle";
import { Archive, Cpu, Database, Download, ListChecks, Plug, Search, Terminal, X } from "lucide-react";
import { resolveLang, type DocsLang } from "@/lib/i18n";

const i18n = {
  en: {
    title: "Offline Driver Downloads",
    subtitle: "Download database drivers and JRE packages for offline use. Search for the exact resource your air-gapped environment needs.",
    jdbcPlugin: "JDBC Plugin",
    jdbcPluginDesc: "Install this optional DBX sidecar before using custom JDBC connections. Database vendor JDBC driver JARs still need to be imported separately.",
    jdbcPluginFile: "Plugin package",
    jdbcPluginInstallHint: "Import this ZIP in DBX from Settings > Driver Manager > JDBC Drivers > Local Install.",
    bundles: "Offline Bundles",
    bundlesDesc: "Platform-specific ZIP packages that include the agent registry, database drivers, native agents, and the matching JRE.",
    drivers: "Database Drivers",
    driversDesc: "Single-driver .tar.zst packages for Java agents. Install the matching JRE separately when it is not already available.",
    nativeAgents: "Native Agents",
    nativeAgentsDesc: "Platform-specific .tar.zst packages for DuckDB, Oracle, KingbaseES, XuguDB, and RabbitMQ. Import the package directly in Driver Manager.",
    jre: "Java Runtime (JRE)",
    jreDesc: "JRE packages used by Java agent-based database drivers such as SQL Server and Dameng.",
    download: "Download",
    installMethod: "Install",
    version: "Version",
    size: "Size",
    requiresJre: "Requires JRE",
    platform: "Platform",
    filename: "File",
    search: "Search drivers, platforms, versions...",
    noResults: "No matching downloads.",
    showing: "Showing",
    of: "of",
    clearSearch: "Clear search",
    mirrorHint: "The CNB mirror is available for GitHub release assets on mainland China networks.",
    downloadSources: "Download source",
    sources: {
      github: "GitHub",
      cnb: "CNB",
      official: "Official",
    },
    downloadHint: "For air-gapped environments: download the bundle for your platform on an internet-connected machine, then transfer it to the offline machine and import it in DBX from Settings > Driver Manager. Use the driver and JRE tabs only when you need individual artifacts.",
    custom: "Custom Bundle",
    customDesc: "Check only the drivers you need; this page assembles a single offline ZIP that imports directly in DBX from Settings > Driver Manager.",
    customPlatform: "Target platform",
    customIncludeJre: `Include JRE 21`,
    customIncludeJreForced: "Included automatically — Java agents require the JRE",
    customSource: "Fetch source",
    customSourceCnb: "CNB (direct)",
    customSourceGithub: "GitHub (via this site)",
    customDownload: "Download bundle",
    customEstimate: "Estimated download",
    customSelected: "selected",
    customSelectAll: "Select all",
    customClear: "Clear",
    customWorkersNote: "The SQLite SSH Worker Linux packages are always included — remote SSH hosts execute them.",
    customNoDrivers: "No drivers match this platform or search.",
    customPhaseDownload: "Downloading",
    customPhaseUnpack: "Unpacking",
    customPhaseAssemble: "Assembling ZIP",
    customPhaseDone: "Custom bundle downloaded ({size}). Import it in DBX from Settings > Driver Manager > offline import.",
    customErrorTitle: "Bundle build failed",
    customCancel: "Cancel",
    customRetryHint: "Check the network or switch the fetch source, then try again.",
    customNativeBadge: "Native",
    customJavaBadge: "Java",
  },
  cn: {
    title: "离线驱动下载",
    subtitle: "下载数据库驱动和 JRE 离线包。搜索内网环境需要的资源，在有网机器下载后传输。",
    jdbcPlugin: "JDBC 插件",
    jdbcPluginDesc: "使用自定义 JDBC 连接前先安装这个 DBX 可选插件。数据库厂商的 JDBC Driver JAR 仍需单独导入。",
    jdbcPluginFile: "插件包",
    jdbcPluginInstallHint: "在 DBX 的“设置 > 驱动管理 > JDBC 驱动 > 本地安装”中导入这个 ZIP。",
    bundles: "整包下载",
    bundlesDesc: "按平台提供的 ZIP 离线包，包含 Agent registry、数据库驱动、原生 Agent 和匹配的 JRE。",
    drivers: "数据库驱动",
    driversDesc: "Java Agent 的单驱动 .tar.zst 包；目标机器尚未安装 JRE 时需要另外安装一次对应 JRE。",
    nativeAgents: "原生 Agent",
    nativeAgentsDesc: "DuckDB、Oracle、金仓KingbaseES、虚谷和 RabbitMQ 的按平台 .tar.zst 单驱动包，可直接在驱动管理中导入。",
    jre: "Java 运行时 (JRE)",
    jreDesc: "Java Agent 驱动所需的 JRE 环境，例如 SQL Server、达梦等连接会使用。",
    download: "下载",
    installMethod: "安装方式",
    version: "版本",
    size: "大小",
    requiresJre: "依赖 JRE",
    platform: "平台",
    filename: "文件",
    search: "搜索驱动、平台、版本...",
    noResults: "没有匹配的下载项。",
    showing: "显示",
    of: "/",
    clearSearch: "清空搜索",
    mirrorHint: "中国大陆网络可选择 CNB 镜像下载，GitHub Release 资源保持同步。",
    downloadSources: "下载来源",
    sources: {
      github: "GitHub",
      cnb: "CNB",
      official: "官方下载",
    },
    downloadHint: "内网环境使用说明：在有网的电脑上下载对应平台的整包，然后传输到内网机器，在 DBX 的“设置 > 驱动管理”中导入。只有需要单个产物时再使用驱动和 JRE 标签页。",
    custom: "自定义离线包",
    customDesc: "只勾选需要的驱动，本页会在浏览器里合成一个离线 ZIP，在 DBX 的“设置 > 驱动管理”中离线导入即可。",
    customPlatform: "目标平台",
    customIncludeJre: "包含 JRE 21",
    customIncludeJreForced: "已自动包含——Java 驱动必须搭配 JRE",
    customSource: "下载源",
    customSourceCnb: "CNB（直连）",
    customSourceGithub: "GitHub（经本站代理）",
    customDownload: "下载离线包",
    customEstimate: "预计下载量",
    customSelected: "已选",
    customSelectAll: "全选",
    customClear: "清空",
    customWorkersNote: "SQLite SSH Worker 的 Linux 包会自动包含——它们在远端 SSH 主机上执行。",
    customNoDrivers: "没有匹配该平台或搜索词的驱动。",
    customPhaseDownload: "正在下载",
    customPhaseUnpack: "正在解包",
    customPhaseAssemble: "正在打包",
    customPhaseDone: "自定义离线包已下载（{size}）。在 DBX 的“设置 > 驱动管理”中离线导入即可。",
    customErrorTitle: "打包失败",
    customCancel: "取消",
    customRetryHint: "请检查网络或切换下载源后重试。",
    customNativeBadge: "原生",
    customJavaBadge: "Java",
  },
};

type ActiveTab = "bundles" | "custom" | "drivers" | "native" | "jre" | "jdbcPlugin";

type BundleSource = "cnb" | "github";

function detectBundlePlatform(): string {
  if (typeof navigator === "undefined") return "windows-x64";
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return /ARM|aarch64/i.test(ua) ? "windows-aarch64" : "windows-x64";
  if (/Macintosh|Mac OS/i.test(ua)) return "macos-x64";
  if (/Linux|X11/i.test(ua)) return /aarch64|arm64/i.test(ua) ? "linux-aarch64" : "linux-x64";
  return "windows-x64";
}

function platformKey(j: JreDisplayEntry): string {
  return `${j.jreKey}-${j.platformKey}`;
}

function bundleKey(bundle: OfflineBundleEntry): string {
  return `${bundle.platformKey}-${bundle.filename}`;
}

type NativeAgentGroup = {
  key: string;
  label: string;
  version: string;
  options: NativeAgentDisplayEntry[];
};

const OFFLINE_HEADING: Record<DocsLang, string> = {
  en: "Offline Usage",
  cn: "离线使用说明",
};

type DriverTranslations = (typeof i18n)["en"];

function DownloadLinks({ url, t }: { url: string; t: DriverTranslations }) {
  return (
    <div className="flex shrink-0 flex-nowrap justify-end gap-1.5 max-[760px]:flex-wrap max-[760px]:justify-start">
      {downloadLinksFor(url).map((link) => (
        <a
          key={link.source}
          href={link.url}
          download
          className={`landing-nav-link inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-[6px] border px-2 text-xs font-medium transition-colors hover:border-landing-blue ${link.source === "cnb" ? "border-landing-blue/45 bg-landing-blue/10 text-landing-sky" : "border-landing-line"}`}
          aria-label={`${t.download}: ${t.sources[link.source as DownloadSource]}`}
        >
          <Download size={13} />
          {t.sources[link.source as DownloadSource]}
        </a>
      ))}
    </div>
  );
}

function matchesSearch(values: Array<string | number | undefined>, query: string): boolean {
  if (!query) return true;
  return values.filter(Boolean).join(" ").toLowerCase().includes(query);
}

export function DriversClient({ initialCatalog, initialRegistry }: { initialCatalog: AgentDownloadCatalog; initialRegistry: AgentRegistry }) {
  const params = useParams();
  const rawLang = params?.lang as string | undefined;
  const lang = resolveLang(rawLang ?? "en");
  const t = i18n[lang];

  const catalog = initialCatalog;
  const [activeTab, setActiveTab] = useState<ActiveTab>("bundles");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNativePlatforms, setSelectedNativePlatforms] = useState<Record<string, string>>({});

  const [bundlePlatform, setBundlePlatform] = useState("windows-x64");
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [includeJre, setIncludeJre] = useState(false);
  const [bundleSource, setBundleSource] = useState<BundleSource>("cnb");
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleProgress, setBundleProgress] = useState<BundleProgress | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [bundleDone, setBundleDone] = useState<number | null>(null);
  const bundleAbortRef = useRef<AbortController | null>(null);

  const bundles = catalog?.bundles ?? [];
  const drivers = catalog?.drivers ?? [];
  const nativeAgents = catalog?.nativeAgents ?? [];
  const jres = catalog?.jres ?? [];
  const jdbcPlugin = catalog?.jdbcPlugin;
  const normalizedSearch = searchQuery.trim().toLowerCase();

  const filteredBundles = useMemo(() => bundles.filter((bundle) => matchesSearch([bundle.platformLabel, bundle.platformKey, bundle.filename, formatSize(bundle.size)], normalizedSearch)), [bundles, normalizedSearch]);

  const filteredDrivers = useMemo(() => drivers.filter((d) => matchesSearch([d.label, d.key, d.version, d.jre, formatSize(d.jar.size)], normalizedSearch)), [drivers, normalizedSearch]);

  const nativeGroups = useMemo(() => {
    const groups = new Map<string, NativeAgentGroup>();
    for (const agent of nativeAgents) {
      const group = groups.get(agent.key);
      if (group) {
        group.options.push(agent);
      } else {
        groups.set(agent.key, { key: agent.key, label: agent.label, version: agent.version, options: [agent] });
      }
    }
    return Array.from(groups.values());
  }, [nativeAgents]);

  useEffect(() => {
    if (nativeGroups.length === 0) return;
    setSelectedNativePlatforms((current) => {
      const next = { ...current };
      let changed = false;
      for (const group of nativeGroups) {
        if (group.options.length === 0) continue;
        if (!next[group.key] || !group.options.some((option) => option.platformKey === next[group.key])) {
          next[group.key] = group.options[0].platformKey;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [nativeGroups]);

  const filteredNativeGroups = useMemo(
    () =>
      nativeGroups.filter((group) =>
        matchesSearch(
          [
            group.label,
            group.key,
            group.version,
            ...group.options.flatMap((option) => [option.platformLabel, option.platformKey, option.filename, formatSize(option.info.size)]),
          ],
          normalizedSearch,
        ),
      ),
    [nativeGroups, normalizedSearch],
  );

  const filteredJres = useMemo(() => jres.filter((j) => matchesSearch([j.platformLabel, j.platformKey, j.jreVersion, j.jreKey, formatSize(j.info.size)], normalizedSearch)), [jres, normalizedSearch]);
  const filteredJdbcPlugin = useMemo(() => (jdbcPlugin && matchesSearch([jdbcPlugin.label, jdbcPlugin.filename, jdbcPlugin.url, t.jdbcPlugin, t.jdbcPluginDesc], normalizedSearch) ? [jdbcPlugin] : []), [jdbcPlugin, normalizedSearch, t.jdbcPlugin, t.jdbcPluginDesc]);

  useEffect(() => {
    // Detected after hydration: the prerendered HTML cannot know the visitor's
    // platform, and a differing initial state would hydration-mismatch.
    setBundlePlatform(detectBundlePlatform());
  }, []);

  const bundleOptions = useMemo(() => buildCustomBundleOptions(initialRegistry, bundlePlatform), [initialRegistry, bundlePlatform]);
  const filteredBundleOptions = useMemo(() => bundleOptions.filter((option) => matchesSearch([option.label, option.key, option.version, option.kind], normalizedSearch)), [bundleOptions, normalizedSearch]);
  const bundleJre = useMemo(() => resolveBundleJre(initialRegistry, bundlePlatform), [initialRegistry, bundlePlatform]);
  const jreRequired = useMemo(() => bundleOptions.some((option) => option.requiresJre && selectedKeys.has(option.key)), [bundleOptions, selectedKeys]);
  const bundlePlan = useMemo(() => computeBundlePlan(initialRegistry, bundlePlatform, selectedKeys, includeJre), [initialRegistry, bundlePlatform, selectedKeys, includeJre]);

  const toggleBundleDriver = (key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const changeBundlePlatform = (platformKey: string) => {
    setBundlePlatform(platformKey);
    setSelectedKeys(new Set());
  };

  const fetchBundlePackage = async (url: string, onProgress: (received: number) => void, signal: AbortSignal): Promise<Uint8Array> => {
    const proxy = proxyUrl(window.location.origin, url);
    const mirror = cnbMirrorUrl(url);
    const attempts: Array<{ label: string; url: string }> =
      bundleSource === "cnb"
        ? [
            { label: t.customSourceCnb, url: mirror },
            { label: t.customSourceGithub, url: proxy },
          ]
        : [
            { label: t.customSourceGithub, url: proxy },
            { label: t.customSourceCnb, url: mirror },
          ];
    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const response = await fetch(attempt.url, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const reader = response.body?.getReader();
        if (!reader) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          onProgress(bytes.length);
          return bytes;
        }
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          onProgress(received);
        }
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return bytes;
      } catch (error) {
        if (signal.aborted) throw error;
        // TypeError is the browser's opaque network/CORS failure; surface a
        // readable cause so the combined message stays diagnosable.
        const cause = error instanceof TypeError ? "network error" : error instanceof Error ? error.message : String(error);
        errors.push(`${attempt.label}: ${cause}`);
      }
    }
    throw new Error(errors.join(" · "));
  };

  const startBundleDownload = async () => {
    if (bundleBusy || selectedKeys.size === 0) return;
    const controller = new AbortController();
    bundleAbortRef.current = controller;
    setBundleBusy(true);
    setBundleError(null);
    setBundleDone(null);
    setBundleProgress(null);
    try {
      const { blob, filename } = await assembleCustomBundle(bundlePlan, fetchBundlePackage, setBundleProgress, controller.signal);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      setBundleDone(blob.size);
    } catch (error) {
      if (!controller.signal.aborted) {
        setBundleError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBundleBusy(false);
      setBundleProgress(null);
      bundleAbortRef.current = null;
    }
  };

  const cancelBundleDownload = () => {
    bundleAbortRef.current?.abort();
  };

  const bundleProgressText = useMemo(() => {
    if (!bundleProgress) return "";
    if (bundleProgress.phase === "download") {
      const expected = bundleProgress.expectedBytes > 0 ? ` / ${formatSize(bundleProgress.expectedBytes)}` : "";
      return `${t.customPhaseDownload} ${bundleProgress.label} (${bundleProgress.index}/${bundleProgress.total}) · ${formatSize(bundleProgress.received)}${expected}`;
    }
    if (bundleProgress.phase === "unpack") return `${t.customPhaseUnpack} ${bundleProgress.label}`;
    if (bundleProgress.phase === "assemble") return t.customPhaseAssemble;
    return "";
  }, [bundleProgress, t]);

  const activeCount = activeTab === "bundles" ? filteredBundles.length : activeTab === "custom" ? filteredBundleOptions.length : activeTab === "drivers" ? filteredDrivers.length : activeTab === "native" ? filteredNativeGroups.length : activeTab === "jre" ? filteredJres.length : filteredJdbcPlugin.length;
  const activeTotal = activeTab === "bundles" ? bundles.length : activeTab === "custom" ? bundleOptions.length : activeTab === "drivers" ? drivers.length : activeTab === "native" ? nativeGroups.length : activeTab === "jre" ? jres.length : jdbcPlugin ? 1 : 0;

  return (
    <main className="landing">
      <LandingNav lang={lang} active="drivers" />

      <section className="pt-[100px] pb-8 max-[760px]:pt-[80px] max-[760px]:pb-6">
        <div className="max-w-[1180px] mx-auto px-7 max-[760px]:px-[18px]">
          <div className="grid justify-items-center max-w-[900px] mx-auto text-center">
            <h1 className="text-[clamp(30px,4vw,46px)] font-[820] leading-[1.08] tracking-tight text-landing-ink">{t.title}</h1>
            <p className="min-w-0 mx-auto text-[15px] font-[460] leading-[1.7] text-landing-muted max-w-[760px] max-[760px]:text-[13px] max-[760px]:whitespace-normal max-[760px]:max-w-[300px]">{t.subtitle}</p>
          </div>
        </div>
      </section>

      <section className="max-w-[1180px] mx-auto px-7 pb-20 max-[760px]:px-[18px]">
        {catalog && (
          <>
            <div className="mb-3 flex items-center gap-2 rounded-[7px] border border-landing-blue/30 bg-landing-blue/10 px-3 py-2 text-xs leading-[1.55] text-landing-sky">
              <Download size={14} className="shrink-0" />
              <span>{t.mirrorHint}</span>
            </div>
            <div className="landing-glass-card mb-12 overflow-hidden rounded-[10px]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-landing-line bg-landing-panel/70 p-3">
                <div className="inline-flex shrink-0 rounded-[8px] border border-landing-line bg-black/10 p-1 max-[760px]:grid max-[760px]:w-full max-[760px]:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab("bundles")}
                    className={`inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-[6px] px-3 text-xs font-[650] transition-colors ${activeTab === "bundles" ? "bg-landing-blue text-white" : "text-landing-muted hover:text-landing-ink"}`}
                  >
                    <Archive size={14} />
                    {t.bundles}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("custom")}
                    className={`inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-[6px] px-3 text-xs font-[650] transition-colors ${activeTab === "custom" ? "bg-landing-blue text-white" : "text-landing-muted hover:text-landing-ink"}`}
                  >
                    <ListChecks size={14} />
                    {t.custom}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("drivers")}
                    className={`inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-[6px] px-3 text-xs font-[650] transition-colors ${activeTab === "drivers" ? "bg-landing-blue text-white" : "text-landing-muted hover:text-landing-ink"}`}
                  >
                    <Database size={14} />
                    {t.drivers}
                  </button>
                  <button type="button" onClick={() => setActiveTab("native")} className={`inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-[6px] px-3 text-xs font-[650] transition-colors ${activeTab === "native" ? "bg-landing-blue text-white" : "text-landing-muted hover:text-landing-ink"}`}>
                    <Terminal size={14} />
                    {t.nativeAgents}
                  </button>
                  <button type="button" onClick={() => setActiveTab("jre")} className={`inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-[6px] px-3 text-xs font-[650] transition-colors ${activeTab === "jre" ? "bg-landing-blue text-white" : "text-landing-muted hover:text-landing-ink"}`}>
                    <Cpu size={14} />
                    {t.jre}
                  </button>
                  <button type="button" onClick={() => setActiveTab("jdbcPlugin")} className={`inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-[6px] px-3 text-xs font-[650] transition-colors ${activeTab === "jdbcPlugin" ? "bg-landing-blue text-white" : "text-landing-muted hover:text-landing-ink"}`}>
                    <Plug size={14} />
                    {t.jdbcPlugin}
                  </button>
                </div>

                <div className="flex min-w-[280px] flex-1 items-center gap-3 max-[760px]:min-w-full">
                  <div className="relative min-w-0 flex-1">
                    <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-landing-muted" />
                    <input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder={t.search}
                      className="h-9 w-full rounded-[8px] border border-landing-line bg-black/10 pl-9 pr-9 text-sm text-landing-ink outline-none transition-colors placeholder:text-landing-muted focus:border-landing-blue"
                    />
                    {searchQuery && (
                      <button type="button" onClick={() => setSearchQuery("")} className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 cursor-pointer place-items-center rounded-[6px] text-landing-muted hover:bg-landing-soft hover:text-landing-ink" aria-label={t.clearSearch}>
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-landing-muted">
                    {t.showing} {activeCount} {t.of} {activeTotal}
                  </span>
                </div>
              </div>

              {activeTab === "jdbcPlugin" && (
                <>
                  <p className="border-b border-landing-line px-5 py-3 text-sm text-landing-muted whitespace-nowrap max-[760px]:whitespace-normal max-[760px]:px-4">{t.jdbcPluginDesc}</p>
                  <table className="w-full table-fixed border-collapse text-sm max-[760px]:block">
                    <thead className="bg-landing-panel text-xs font-medium text-landing-muted max-[760px]:hidden">
                      <tr className="border-b border-landing-line">
                        <th className="w-[22%] px-5 py-2.5 text-left font-medium">{t.jdbcPluginFile}</th>
                        <th className="px-5 py-2.5 text-left font-medium">{t.filename}</th>
                        <th className="px-5 py-2.5 text-left font-medium">{t.installMethod}</th>
                        <th className="w-[340px] px-5 py-2.5 text-right font-medium">{t.downloadSources}</th>
                      </tr>
                    </thead>
                    <tbody className="max-[760px]:block">
                      {filteredJdbcPlugin.map((plugin) => (
                        <tr key={plugin.filename} className="border-b border-landing-line transition-colors last:border-b-0 hover:bg-landing-panel max-[760px]:grid max-[760px]:grid-cols-[1fr_auto] max-[760px]:items-center max-[760px]:gap-3 max-[760px]:px-4">
                          <td className="min-w-0 px-5 py-3 font-medium text-landing-ink max-[760px]:px-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="min-w-0 truncate">{plugin.label}</span>
                              <span className="hidden shrink-0 rounded-[5px] border border-landing-blue/35 bg-landing-blue/10 px-1.5 py-0.5 font-mono text-[11px] text-landing-sky max-[760px]:inline">ZIP</span>
                            </div>
                            <p className="mt-1 hidden text-xs leading-[1.55] text-landing-muted max-[760px]:block">{t.jdbcPluginInstallHint}</p>
                          </td>
                          <td className="px-5 py-3 font-mono text-[11px] text-landing-muted max-[760px]:hidden"><span className="block truncate" title={plugin.filename}>{plugin.filename}</span></td>
                          <td className="px-5 py-3 text-xs text-landing-muted max-[760px]:hidden">{t.jdbcPluginInstallHint}</td>
                          <td className="px-5 py-3 text-right max-[760px]:col-span-2 max-[760px]:px-0 max-[760px]:pt-0">
                            <DownloadLinks url={plugin.url} t={t} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredJdbcPlugin.length === 0 && <div className="px-5 py-12 text-center text-sm text-landing-muted">{t.noResults}</div>}
                </>
              )}

              {activeTab === "bundles" && (
                <>
                  <p className="border-b border-landing-line px-5 py-3 text-sm text-landing-muted whitespace-nowrap max-[760px]:whitespace-normal max-[760px]:px-4">{t.bundlesDesc}</p>
                  <table className="w-full table-fixed border-collapse text-sm max-[760px]:block">
                    <thead className="bg-landing-panel text-xs font-medium text-landing-muted max-[760px]:hidden">
                      <tr className="border-b border-landing-line">
                        <th className="w-[22%] px-5 py-2.5 text-left font-medium">{t.platform}</th>
                        <th className="px-5 py-2.5 text-left font-medium">{t.filename}</th>
                        <th className="w-[116px] px-5 py-2.5 text-right font-medium">{t.size}</th>
                        <th className="w-[340px] px-5 py-2.5 text-right font-medium">{t.downloadSources}</th>
                      </tr>
                    </thead>
                    <tbody className="max-[760px]:block">
                      {filteredBundles.map((bundle) => (
                        <tr key={bundleKey(bundle)} className="border-b border-landing-line transition-colors last:border-b-0 hover:bg-landing-panel max-[760px]:grid max-[760px]:grid-cols-[1fr_auto] max-[760px]:items-center max-[760px]:gap-3 max-[760px]:px-4">
                          <td className="min-w-0 px-5 py-3 font-medium text-landing-ink max-[760px]:px-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="min-w-0 truncate">{bundle.platformLabel}</span>
                              <span className="hidden shrink-0 rounded-[5px] border border-landing-blue/35 bg-landing-blue/10 px-1.5 py-0.5 font-mono text-[11px] text-landing-sky max-[760px]:inline">ZIP</span>
                            </div>
                          </td>
                          <td className="px-5 py-3 font-mono text-[11px] text-landing-muted max-[760px]:hidden"><span className="block truncate" title={bundle.filename}>{bundle.filename}</span></td>
                          <td className="whitespace-nowrap px-5 py-3 text-right text-xs text-landing-muted max-[760px]:hidden">{formatSize(bundle.size)}</td>
                          <td className="px-5 py-3 text-right max-[760px]:col-span-2 max-[760px]:px-0 max-[760px]:pt-0">
                            <DownloadLinks url={bundle.url} t={t} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredBundles.length === 0 && <div className="px-5 py-12 text-center text-sm text-landing-muted">{t.noResults}</div>}
                </>
              )}

              {activeTab === "custom" && (
                <>
                  <p className="border-b border-landing-line px-5 py-3 text-sm text-landing-muted whitespace-nowrap max-[760px]:whitespace-normal max-[760px]:px-4">{t.customDesc}</p>
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-landing-line px-5 py-3 max-[760px]:px-4">
                    <div className="flex items-center gap-2 text-xs text-landing-muted">
                      <span className="shrink-0">{t.customPlatform}</span>
                      <LandingSelect
                        value={bundlePlatform}
                        options={CUSTOM_BUNDLE_PLATFORMS.map((platformKey) => ({ value: platformKey, label: platformLabels[platformKey] ?? platformKey }))}
                        onChange={changeBundlePlatform}
                        ariaLabel={t.customPlatform}
                        className="min-w-[190px]"
                      />
                    </div>
                    <label className={`flex items-center gap-2 text-xs ${jreRequired ? "text-landing-sky" : "text-landing-muted"}`} title={jreRequired ? t.customIncludeJreForced : undefined}>
                      <input
                        type="checkbox"
                        checked={includeJre || jreRequired}
                        disabled={jreRequired || !bundleJre || bundleBusy}
                        onChange={() => setIncludeJre((current) => !current)}
                        className="h-3.5 w-3.5 accent-landing-blue"
                      />
                      {t.customIncludeJre}
                      {bundleJre ? ` (${formatSize(bundleJre.size)})` : ""}
                    </label>
                    <div className="flex items-center gap-2 text-xs text-landing-muted">
                      <span className="shrink-0">{t.customSource}</span>
                      <LandingSelect<BundleSource>
                        value={bundleSource}
                        options={[
                          { value: "cnb", label: t.customSourceCnb },
                          { value: "github", label: t.customSourceGithub },
                        ]}
                        onChange={setBundleSource}
                        disabled={bundleBusy}
                        ariaLabel={t.customSource}
                      />
                    </div>
                    <div className="relative min-w-[200px] flex-1 max-[760px]:min-w-full">
                      <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-landing-muted" />
                      <input
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder={t.search}
                        className="h-8 w-full rounded-[6px] border border-landing-line bg-black/10 pl-8 pr-8 text-xs text-landing-ink outline-none transition-colors placeholder:text-landing-muted focus:border-landing-blue"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery("")}
                          className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 cursor-pointer place-items-center rounded-[5px] text-landing-muted hover:bg-landing-soft hover:text-landing-ink"
                          aria-label={t.clearSearch}
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="max-h-[520px] overflow-y-auto">
                    <table className="w-full table-fixed border-collapse text-sm max-[760px]:block">
                      <thead className="sticky top-0 z-10 bg-landing-panel text-xs font-medium text-landing-muted max-[760px]:hidden">
                        <tr className="border-b border-landing-line">
                          <th className="w-[36px] px-5 py-2.5 text-left font-medium"><span className="sr-only">{t.customSelectAll}</span></th>
                          <th className="w-[24%] px-5 py-2.5 text-left font-medium">Driver</th>
                          <th className="px-5 py-2.5 text-left font-medium">{t.version}</th>
                          <th className="w-[116px] px-5 py-2.5 text-right font-medium">{t.size}</th>
                        </tr>
                      </thead>
                      <tbody className="max-[760px]:block">
                        {filteredBundleOptions.map((option) => {
                          const checked = selectedKeys.has(option.key);
                          return (
                            <tr key={option.key} className={`border-b border-landing-line transition-colors last:border-b-0 ${checked ? "bg-landing-blue/10" : "hover:bg-landing-panel"} max-[760px]:grid max-[760px]:grid-cols-[auto_1fr_auto] max-[760px]:items-center max-[760px]:gap-3 max-[760px]:px-4`}>
                              <td className="px-5 py-3 max-[760px]:px-0">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={bundleBusy}
                                  onChange={() => toggleBundleDriver(option.key)}
                                  aria-label={`${t.customDownload}: ${option.label}`}
                                  className="h-4 w-4 cursor-pointer accent-landing-blue"
                                />
                              </td>
                              <td className="min-w-0 px-5 py-3 font-medium text-landing-ink max-[760px]:px-0">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="min-w-0 truncate">{option.label}</span>
                                  <span className="hidden shrink-0 rounded-[5px] border border-landing-blue/35 bg-landing-blue/10 px-1.5 py-0.5 font-mono text-[11px] text-landing-sky max-[760px]:inline">{option.key}</span>
                                  <span className={`hidden shrink-0 rounded-[5px] border px-1.5 py-0.5 font-mono text-[11px] max-[760px]:inline ${option.kind === "native" ? "border-landing-green/35 bg-landing-green/10 text-landing-green" : "border-landing-line bg-black/10 text-landing-muted"}`}>
                                    {option.kind === "native" ? t.customNativeBadge : t.customJavaBadge}
                                  </span>
                                </div>
                              </td>
                              <td className="px-5 py-3 text-xs text-landing-muted max-[760px]:hidden">{option.version}</td>
                              <td className="whitespace-nowrap px-5 py-3 text-right text-xs text-landing-muted max-[760px]:hidden">{formatSize(option.packageSize)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {filteredBundleOptions.length === 0 && <div className="px-5 py-12 text-center text-sm text-landing-muted">{t.customNoDrivers}</div>}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-landing-line px-5 py-3 max-[760px]:px-4">
                    <div className="min-w-0 text-xs leading-[1.6] text-landing-muted">
                      <div>
                        {t.customSelected} {selectedKeys.size} · {t.customEstimate} {formatSize(bundlePlan.totalDownloadBytes)}
                      </div>
                      <div className="text-landing-muted/80">{t.customWorkersNote}</div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={bundleBusy || filteredBundleOptions.length === 0}
                        onClick={() => setSelectedKeys(new Set(filteredBundleOptions.map((option) => option.key)))}
                        className="h-8 cursor-pointer rounded-[6px] border border-landing-line px-3 text-xs font-medium text-landing-muted transition-colors hover:border-landing-blue hover:text-landing-ink disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t.customSelectAll}
                      </button>
                      <button
                        type="button"
                        disabled={bundleBusy || selectedKeys.size === 0}
                        onClick={() => setSelectedKeys(new Set())}
                        className="h-8 cursor-pointer rounded-[6px] border border-landing-line px-3 text-xs font-medium text-landing-muted transition-colors hover:border-landing-blue hover:text-landing-ink disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t.customClear}
                      </button>
                      {bundleBusy ? (
                        <button
                          type="button"
                          onClick={cancelBundleDownload}
                          className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-[6px] border border-landing-line px-3 text-xs font-[650] text-landing-ink transition-colors hover:border-[#ff7376] hover:text-[#ff7376]"
                        >
                          <X size={13} />
                          {t.customCancel}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={selectedKeys.size === 0}
                          onClick={startBundleDownload}
                          className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-[6px] bg-landing-blue px-3 text-xs font-[650] text-white transition-colors hover:bg-landing-blue/85 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Download size={13} />
                          {t.customDownload}
                        </button>
                      )}
                    </div>
                  </div>
                  {bundleProgress && bundleBusy && (
                    <div className="border-t border-landing-line px-5 py-3 text-xs text-landing-sky max-[760px]:px-4">{bundleProgressText}</div>
                  )}
                  {bundleError && (
                    <div className="border-t border-landing-line px-5 py-3 text-xs leading-[1.6] text-[#ff7376] max-[760px]:px-4">
                      <strong>{t.customErrorTitle}：</strong>
                      {bundleError}
                      <div className="text-landing-muted">{t.customRetryHint}</div>
                    </div>
                  )}
                  {bundleDone !== null && !bundleBusy && (
                    <div className="border-t border-landing-line px-5 py-3 text-xs leading-[1.6] text-landing-green max-[760px]:px-4">
                      {t.customPhaseDone.replace("{size}", formatSize(bundleDone))}
                    </div>
                  )}
                </>
              )}

              {activeTab === "drivers" && (
                <>
                  <p className="border-b border-landing-line px-5 py-3 text-sm text-landing-muted whitespace-nowrap max-[760px]:whitespace-normal max-[760px]:px-4">{t.driversDesc}</p>
                  <table className="w-full table-fixed border-collapse text-sm max-[760px]:block">
                    <thead className="bg-landing-panel text-xs font-medium text-landing-muted max-[760px]:hidden">
                      <tr className="border-b border-landing-line">
                        <th className="w-[18%] px-5 py-2.5 text-left font-medium">Driver</th>
                        <th className="w-[14%] px-5 py-2.5 text-left font-medium">Key</th>
                        <th className="px-5 py-2.5 text-left font-medium">{t.version}</th>
                        <th className="px-5 py-2.5 text-left font-medium">{t.requiresJre}</th>
                        <th className="w-[116px] px-5 py-2.5 text-right font-medium">{t.size}</th>
                        <th className="w-[340px] px-5 py-2.5 text-right font-medium">{t.downloadSources}</th>
                      </tr>
                    </thead>
                    <tbody className="max-[760px]:block">
                      {filteredDrivers.map((d) => (
                        <tr key={d.key} className="border-b border-landing-line transition-colors last:border-b-0 hover:bg-landing-panel max-[760px]:grid max-[760px]:grid-cols-[1fr_auto] max-[760px]:items-center max-[760px]:gap-3 max-[760px]:px-4">
                          <td className="min-w-0 px-5 py-3 font-medium text-landing-ink max-[760px]:px-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="min-w-0 truncate">{d.label}</span>
                              <span className="hidden shrink-0 rounded-[5px] border border-landing-blue/35 bg-landing-blue/10 px-1.5 py-0.5 font-mono text-[11px] text-landing-sky max-[760px]:inline">{d.key}</span>
                            </div>
                          </td>
                          <td className="px-5 py-3 max-[760px]:hidden">
                            <span className="inline-flex rounded-[5px] border border-landing-blue/35 bg-landing-blue/10 px-1.5 py-0.5 font-mono text-[11px] text-landing-sky">{d.key}</span>
                          </td>
                          <td className="px-5 py-3 text-xs text-landing-muted max-[760px]:hidden">{d.version}</td>
                          <td className="px-5 py-3 text-xs text-landing-muted max-[760px]:hidden">{d.jre}</td>
                          <td className="whitespace-nowrap px-5 py-3 text-right text-xs text-landing-muted max-[760px]:hidden">{formatSize(d.jar.size)}</td>
                          <td className="px-5 py-3 text-right max-[760px]:col-span-2 max-[760px]:px-0 max-[760px]:pt-0">
                            <DownloadLinks url={d.jar.url} t={t} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredDrivers.length === 0 && <div className="px-5 py-12 text-center text-sm text-landing-muted">{t.noResults}</div>}
                </>
              )}

              {activeTab === "native" && (
                <>
                  <p className="border-b border-landing-line px-5 py-3 text-sm text-landing-muted whitespace-nowrap max-[760px]:whitespace-normal max-[760px]:px-4">{t.nativeAgentsDesc}</p>
                  <table className="w-full table-fixed border-collapse text-sm max-[760px]:block">
                    <thead className="bg-landing-panel text-xs font-medium text-landing-muted max-[760px]:hidden">
                      <tr className="border-b border-landing-line">
                        <th className="w-[22%] px-5 py-2.5 text-left font-medium">Agent</th>
                        <th className="px-5 py-2.5 text-left font-medium">{t.platform}</th>
                        <th className="px-5 py-2.5 text-left font-medium">{t.version}</th>
                        <th className="w-[116px] px-5 py-2.5 text-right font-medium">{t.size}</th>
                        <th className="w-[340px] px-5 py-2.5 text-right font-medium">{t.downloadSources}</th>
                      </tr>
                    </thead>
                    <tbody className="max-[760px]:block">
                      {filteredNativeGroups.map((group) => {
                        const selectedPlatform = selectedNativePlatforms[group.key] ?? group.options[0]?.platformKey;
                        const selectedAgent = group.options.find((option) => option.platformKey === selectedPlatform) ?? group.options[0];
                        if (!selectedAgent) return null;
                        return (
                          <tr key={group.key} className="border-b border-landing-line transition-colors last:border-b-0 hover:bg-landing-panel max-[760px]:grid max-[760px]:grid-cols-[1fr_auto] max-[760px]:items-center max-[760px]:gap-3 max-[760px]:px-4">
                            <td className="min-w-0 px-5 py-3 font-medium text-landing-ink max-[760px]:px-0">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="min-w-0 truncate">{group.label}</span>
                                <span className="hidden shrink-0 rounded-[5px] border border-landing-blue/35 bg-landing-blue/10 px-1.5 py-0.5 font-mono text-[11px] text-landing-sky max-[760px]:inline">{selectedAgent.platformKey}</span>
                              </div>
                            </td>
                            <td className="px-5 py-3 max-[760px]:col-span-2 max-[760px]:px-0 max-[760px]:pt-0">
                              <LandingSelect
                                value={selectedAgent.platformKey}
                                options={group.options.map((option) => ({ value: option.platformKey, label: option.platformLabel }))}
                                onChange={(platformKey) => setSelectedNativePlatforms((current) => ({ ...current, [group.key]: platformKey }))}
                                ariaLabel={`${group.label}: ${t.platform}`}
                                className="min-w-[190px] max-[760px]:w-full"
                              />
                            </td>
                            <td className="px-5 py-3 text-xs text-landing-muted max-[760px]:hidden">{group.version}</td>
                            <td className="whitespace-nowrap px-5 py-3 text-right text-xs text-landing-muted max-[760px]:hidden">{formatSize(selectedAgent.info.size)}</td>
                            <td className="px-5 py-3 text-right max-[760px]:col-span-2 max-[760px]:px-0 max-[760px]:pt-0">
                              <DownloadLinks url={selectedAgent.info.url} t={t} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {filteredNativeGroups.length === 0 && <div className="px-5 py-12 text-center text-sm text-landing-muted">{t.noResults}</div>}
                </>
              )}

              {activeTab === "jre" && (
                <>
                  <p className="border-b border-landing-line px-5 py-3 text-sm text-landing-muted whitespace-nowrap max-[760px]:whitespace-normal max-[760px]:px-4">{t.jreDesc}</p>
                  <table className="w-full table-fixed border-collapse text-sm max-[760px]:block">
                    <thead className="bg-landing-panel text-xs font-medium text-landing-muted max-[760px]:hidden">
                      <tr className="border-b border-landing-line">
                        <th className="w-[24%] px-5 py-2.5 text-left font-medium">{t.platform}</th>
                        <th className="px-5 py-2.5 text-left font-medium">JRE</th>
                        <th className="px-5 py-2.5 text-left font-medium">{t.version}</th>
                        <th className="w-[116px] px-5 py-2.5 text-right font-medium">{t.size}</th>
                        <th className="w-[340px] px-5 py-2.5 text-right font-medium">{t.downloadSources}</th>
                      </tr>
                    </thead>
                    <tbody className="max-[760px]:block">
                      {filteredJres.map((j) => {
                        const key = platformKey(j);
                        return (
                          <tr key={key} className="border-b border-landing-line transition-colors last:border-b-0 hover:bg-landing-panel max-[760px]:grid max-[760px]:grid-cols-[1fr_auto] max-[760px]:items-center max-[760px]:gap-3 max-[760px]:px-4">
                            <td className="min-w-0 px-5 py-3 font-medium text-landing-ink max-[760px]:px-0">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="min-w-0 truncate">{j.platformLabel}</span>
                                <span className="hidden shrink-0 rounded-[5px] border border-landing-green/35 bg-landing-green/10 px-1.5 py-0.5 font-mono text-[11px] text-landing-green max-[760px]:inline">JRE {j.jreKey}</span>
                              </div>
                            </td>
                            <td className="px-5 py-3 max-[760px]:hidden">
                              <span className="inline-flex rounded-[5px] border border-landing-green/35 bg-landing-green/10 px-1.5 py-0.5 font-mono text-[11px] text-landing-green">JRE {j.jreKey}</span>
                            </td>
                            <td className="px-5 py-3 text-xs text-landing-muted max-[760px]:hidden">{j.jreVersion}</td>
                            <td className="whitespace-nowrap px-5 py-3 text-right text-xs text-landing-muted max-[760px]:hidden">{formatSize(j.info.size)}</td>
                            <td className="px-5 py-3 text-right max-[760px]:col-span-2 max-[760px]:px-0 max-[760px]:pt-0">
                              <DownloadLinks url={j.info.url} t={t} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {filteredJres.length === 0 && <div className="px-5 py-12 text-center text-sm text-landing-muted">{t.noResults}</div>}
                </>
              )}
            </div>

            <div className="landing-glass-card rounded-[10px] p-5 text-sm text-landing-muted leading-[1.65]">
              <strong className="text-landing-ink">{OFFLINE_HEADING[lang]}</strong>
              <p className="mt-1">{t.downloadHint}</p>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
