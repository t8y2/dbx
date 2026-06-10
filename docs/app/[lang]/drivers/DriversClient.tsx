"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { LandingNav } from "@/components/landing/LandingNav";
import { buildDriverEntries, buildJreEntries, fetchAgentRegistry, formatSize, type AgentRegistry, type JreDisplayEntry } from "@/lib/agentRegistry";
import { AlertTriangle, Cpu, Database, Download, Loader2, Search, X } from "lucide-react";

const i18n = {
  en: {
    title: "Offline Driver Downloads",
    subtitle: "Download database drivers and JRE packages for offline use. Search for the exact resource your air-gapped environment needs.",
    drivers: "Database Drivers",
    driversDesc: "JDBC driver JAR files for each supported database type.",
    jre: "Java Runtime (JRE)",
    jreDesc: "JRE packages used by agent-based database drivers. Required for Oracle, SQL Server, and other agent-managed connections.",
    loading: "Loading driver catalog...",
    error: "Unable to load driver catalog. Please check your network connection.",
    retry: "Retry",
    download: "Download",
    version: "Version",
    size: "Size",
    requiresJre: "Requires JRE",
    platform: "Platform",
    search: "Search drivers, platforms, versions...",
    noResults: "No matching downloads.",
    showing: "Showing",
    of: "of",
    clearSearch: "Clear search",
    downloadHint: "For air-gapped environments: download these files on an internet-connected machine, then transfer them to the offline machine and import them in DBX from Settings > Driver Manager.",
  },
  cn: {
    title: "离线驱动下载",
    subtitle: "下载数据库驱动和 JRE 离线包。搜索内网环境需要的资源，在有网机器下载后传输。",
    drivers: "数据库驱动",
    driversDesc: "每种支持的数据库类型对应的 JDBC 驱动 JAR 文件。",
    jre: "Java 运行时 (JRE)",
    jreDesc: "Agent 驱动所需的 JRE 环境，Oracle、SQL Server 等数据库通过 Agent 连接时需要。",
    loading: "正在加载驱动列表...",
    error: "加载驱动列表失败，请检查网络连接。",
    retry: "重试",
    download: "下载",
    version: "版本",
    size: "大小",
    requiresJre: "依赖 JRE",
    platform: "平台",
    search: "搜索驱动、平台、版本...",
    noResults: "没有匹配的下载项。",
    showing: "显示",
    of: "/",
    clearSearch: "清空搜索",
    downloadHint: "内网环境使用说明：在有网的电脑上下载这些文件，然后传输到内网机器，在 DBX 的“设置 > 驱动管理”中导入。",
  },
};

type ActiveTab = "drivers" | "jre";

function platformKey(j: JreDisplayEntry): string {
  return `${j.jreKey}-${j.platformKey}`;
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

  const [registry, setRegistry] = useState<AgentRegistry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("drivers");
  const [searchQuery, setSearchQuery] = useState("");

  const loadRegistry = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAgentRegistry();
      if (data) {
        setRegistry(data);
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
    loadRegistry();
  }, [loadRegistry]);

  const drivers = useMemo(() => (registry ? buildDriverEntries(registry) : []), [registry]);
  const jres = useMemo(() => (registry ? buildJreEntries(registry) : []), [registry]);
  const normalizedSearch = searchQuery.trim().toLowerCase();

  const filteredDrivers = useMemo(() => drivers.filter((d) => matchesSearch([d.label, d.key, d.version, d.jre, formatSize(d.jar.size)], normalizedSearch)), [drivers, normalizedSearch]);

  const filteredJres = useMemo(() => jres.filter((j) => matchesSearch([j.platformLabel, j.platformKey, j.jreVersion, j.jreKey, formatSize(j.info.size)], normalizedSearch)), [jres, normalizedSearch]);

  const activeCount = activeTab === "drivers" ? filteredDrivers.length : filteredJres.length;
  const activeTotal = activeTab === "drivers" ? drivers.length : jres.length;

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
            <button type="button" onClick={loadRegistry} className="landing-nav-link rounded-[7px] px-4 py-2 text-sm font-medium border border-landing-line">
              {t.retry}
            </button>
          </div>
        )}

        {registry && !loading && (
          <>
            <div className="landing-glass-card mb-12 overflow-hidden rounded-[10px]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-landing-line bg-landing-panel/70 p-3">
                <div className="inline-flex shrink-0 rounded-[8px] border border-landing-line bg-black/10 p-1">
                  <button
                    type="button"
                    onClick={() => setActiveTab("drivers")}
                    className={`inline-flex h-8 cursor-pointer items-center gap-2 rounded-[6px] px-3 text-xs font-[650] transition-colors ${activeTab === "drivers" ? "bg-landing-blue text-white" : "text-landing-muted hover:text-landing-ink"}`}
                  >
                    <Database size={14} />
                    {t.drivers}
                  </button>
                  <button type="button" onClick={() => setActiveTab("jre")} className={`inline-flex h-8 cursor-pointer items-center gap-2 rounded-[6px] px-3 text-xs font-[650] transition-colors ${activeTab === "jre" ? "bg-landing-blue text-white" : "text-landing-muted hover:text-landing-ink"}`}>
                    <Cpu size={14} />
                    {t.jre}
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

              {activeTab === "drivers" && (
                <>
                  <p className="border-b border-landing-line px-5 py-3 text-sm text-landing-muted whitespace-nowrap max-[760px]:whitespace-normal max-[760px]:px-4">{t.driversDesc}</p>
                  <table className="w-full table-auto border-collapse text-sm max-[760px]:block">
                    <thead className="bg-landing-panel text-xs font-medium text-landing-muted max-[760px]:hidden">
                      <tr className="border-b border-landing-line">
                        <th className="px-5 py-2.5 text-left font-medium">Driver</th>
                        <th className="px-5 py-2.5 text-left font-medium">Key</th>
                        <th className="px-5 py-2.5 text-left font-medium">{t.version}</th>
                        <th className="px-5 py-2.5 text-left font-medium">{t.requiresJre}</th>
                        <th className="px-5 py-2.5 text-right font-medium">{t.size}</th>
                        <th className="w-24 px-5 py-2.5" />
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
                          <td className="px-5 py-3 text-right text-xs text-landing-muted max-[760px]:hidden">{formatSize(d.jar.size)}</td>
                          <td className="px-5 py-3 text-right max-[760px]:px-0">
                            <a href={d.jar.url} download className="landing-nav-link inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-[6px] border border-landing-line px-2.5 text-xs font-medium transition-colors hover:border-landing-blue">
                              <Download size={13} />
                              {t.download}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredDrivers.length === 0 && <div className="px-5 py-12 text-center text-sm text-landing-muted">{t.noResults}</div>}
                </>
              )}

              {activeTab === "jre" && (
                <>
                  <p className="border-b border-landing-line px-5 py-3 text-sm text-landing-muted whitespace-nowrap max-[760px]:whitespace-normal max-[760px]:px-4">{t.jreDesc}</p>
                  <table className="w-full table-auto border-collapse text-sm max-[760px]:block">
                    <thead className="bg-landing-panel text-xs font-medium text-landing-muted max-[760px]:hidden">
                      <tr className="border-b border-landing-line">
                        <th className="px-5 py-2.5 text-left font-medium">{t.platform}</th>
                        <th className="px-5 py-2.5 text-left font-medium">JRE</th>
                        <th className="px-5 py-2.5 text-left font-medium">{t.version}</th>
                        <th className="px-5 py-2.5 text-right font-medium">{t.size}</th>
                        <th className="w-24 px-5 py-2.5" />
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
                            <td className="px-5 py-3 text-right text-xs text-landing-muted max-[760px]:hidden">{formatSize(j.info.size)}</td>
                            <td className="px-5 py-3 text-right max-[760px]:px-0">
                              <a href={j.info.url} download className="landing-nav-link inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-[6px] border border-landing-line px-2.5 text-xs font-medium transition-colors hover:border-landing-blue">
                                <Download size={13} />
                                {t.download}
                              </a>
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
