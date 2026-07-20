"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { LandingNav } from "@/components/landing/LandingNav";
import { downloadLinksFor, fetchAgentDownloadCatalog, formatSize, type AgentDownloadCatalog, type DownloadSource, type JreDisplayEntry, type NativeAgentDisplayEntry, type OfflineBundleEntry } from "@/lib/agentRegistry";
import { AlertTriangle, Archive, Cpu, Database, Download, Loader2, Plug, Search, Terminal, X } from "lucide-react";

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
    driversDesc: "JDBC driver JAR files for each supported database type.",
    nativeAgents: "Native Agents",
    nativeAgentsDesc: "Go-based native agents for Oracle, KingBase, and XuguDB. Download the executable that matches the offline machine.",
    jre: "Java Runtime (JRE)",
    jreDesc: "JRE packages used by agent-based database drivers. Required for Oracle, SQL Server, and other agent-managed connections.",
    loading: "Loading driver catalog...",
    error: "Unable to load driver catalog. Please check your network connection.",
    retry: "Retry",
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
    driversDesc: "每种支持的数据库类型对应的 JDBC 驱动 JAR 文件。",
    nativeAgents: "原生 Agent",
    nativeAgentsDesc: "Oracle、人大金仓和虚谷使用 Go 原生 Agent，请下载与内网机器平台匹配的可执行文件。",
    jre: "Java 运行时 (JRE)",
    jreDesc: "Agent 驱动所需的 JRE 环境，Oracle、SQL Server 等数据库通过 Agent 连接时需要。",
    loading: "正在加载驱动列表...",
    error: "加载驱动列表失败，请检查网络连接。",
    retry: "重试",
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
  },
};

type ActiveTab = "bundles" | "drivers" | "native" | "jre" | "jdbcPlugin";

function platformKey(j: JreDisplayEntry): string {
  return `${j.jreKey}-${j.platformKey}`;
}

function bundleKey(bundle: OfflineBundleEntry): string {
  return `${bundle.platformKey}-${bundle.filename}`;
}

function nativeKey(agent: NativeAgentDisplayEntry): string {
  return `${agent.key}-${agent.platformKey}`;
}

type NativeAgentGroup = {
  key: string;
  label: string;
  version: string;
  options: NativeAgentDisplayEntry[];
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

export function DriversClient() {
  const params = useParams();
  const rawLang = params?.lang as string | undefined;
  const lang: "en" | "cn" = rawLang === "cn" ? "cn" : "en";
  const t = i18n[lang];

  const [catalog, setCatalog] = useState<AgentDownloadCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("bundles");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNativePlatforms, setSelectedNativePlatforms] = useState<Record<string, string>>({});

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAgentDownloadCatalog();
      if (data) {
        setCatalog(data);
      } else {
        setError("Unable to load driver catalog");
      }
    } catch {
      setError("Unable to load driver catalog");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

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

  const activeCount = activeTab === "bundles" ? filteredBundles.length : activeTab === "drivers" ? filteredDrivers.length : activeTab === "native" ? filteredNativeGroups.length : activeTab === "jre" ? filteredJres.length : filteredJdbcPlugin.length;
  const activeTotal = activeTab === "bundles" ? bundles.length : activeTab === "drivers" ? drivers.length : activeTab === "native" ? nativeGroups.length : activeTab === "jre" ? jres.length : jdbcPlugin ? 1 : 0;

  return (
    <main className="landing">
      <LandingNav lang={lang} active="drivers" />

      <section className="pt-[100px] pb-8 max-[760px]:pt-[80px] max-[760px]:pb-6">
        <div className="max-w-[1180px] mx-auto px-7 max-[760px]:px-[18px]">
          <div className="grid justify-items-center max-w-[900px] mx-auto text-center">
            <p className="min-w-0 mx-auto text-[15px] font-[460] leading-[1.7] text-landing-muted max-w-[760px] max-[760px]:text-[13px] max-[760px]:whitespace-normal max-[760px]:max-w-[300px]">{t.subtitle}</p>
          </div>
        </div>
      </section>

      <section className="max-w-[1180px] mx-auto px-7 pb-20 max-[760px]:px-[18px]">
        {loading && (
          <div className="flex items-center justify-center gap-3 py-20 text-landing-muted">
            <Loader2 size={20} className="animate-spin" />
            <span className="text-sm">{t.loading}</span>
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col items-center gap-4 py-20">
            <AlertTriangle size={28} className="text-yellow-500" />
            <span className="text-landing-muted text-sm">{t.error}</span>
            <button type="button" onClick={loadCatalog} className="landing-nav-link rounded-[7px] px-4 py-2 text-sm font-medium border border-landing-line">
              {t.retry}
            </button>
          </div>
        )}

        {catalog && !loading && (
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
                              <select
                                value={selectedAgent.platformKey}
                                onChange={(event) => setSelectedNativePlatforms((current) => ({ ...current, [group.key]: event.target.value }))}
                                className="h-8 min-w-[190px] rounded-[6px] border border-landing-line bg-black/10 px-2.5 text-xs text-landing-ink outline-none transition-colors focus:border-landing-blue max-[760px]:w-full"
                              >
                                {group.options.map((option) => (
                                  <option key={nativeKey(option)} value={option.platformKey} className="bg-[#10151d] text-landing-ink">
                                    {option.platformLabel}
                                  </option>
                                ))}
                              </select>
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
              <strong className="text-landing-ink">{lang === "cn" ? "离线使用说明" : "Offline Usage"}</strong>
              <p className="mt-1">{t.downloadHint}</p>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
