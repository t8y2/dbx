"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LandingNav } from "@/components/landing/LandingNav";
import { LandingFooter } from "@/components/landing/LandingFooter";
import type { DocsLang } from "@/lib/i18n";
import {
  DBX_STORE_CONTRIBUTING_URL,
  fetchPluginCatalog,
  latestPluginVersion,
  pluginDisplayDescription,
  pluginDisplayName,
  type MarketplacePlugin,
} from "@/lib/pluginCatalog";

const i18n = {
  en: {
    title: "Plugin Center",
    viewPlugin: "View plugin",
    refreshError: "Could not refresh the catalog; showing the last snapshot.",
    submitTitle: "Built a plugin for DBX?",
    submitDesc: "Package it as a .dbxp, submit a PR to dbx-store, and it will appear here and in the in-app plugin center after review.",
    submitAction: "Submit to dbx-store",
    submitDocs: "Plugin development docs",
    emptyTitle: "No plugins yet",
    emptyDesc: "The marketplace catalog is empty or unreachable right now. Try again in a moment.",
  },
  cn: {
    title: "插件中心",
    viewPlugin: "查看插件",
    refreshError: "目录刷新失败，当前展示构建时的快照。",
    submitTitle: "为 DBX 开发了插件？",
    submitDesc: "打包为 .dbxp，向 dbx-store 提交 PR，审核通过后会同时出现在本页面和客户端插件中心。",
    submitAction: "提交到 dbx-store",
    submitDocs: "插件开发文档",
    emptyTitle: "暂无插件",
    emptyDesc: "商店目录暂时为空或无法访问，请稍后再试。",
  },
};

function mergePlugins(snapshot: MarketplacePlugin[], live: MarketplacePlugin[]): MarketplacePlugin[] {
  if (!snapshot.length) return live;
  const byId = new Map(snapshot.map((plugin) => [plugin.id, plugin]));
  for (const plugin of live) byId.set(plugin.id, plugin);
  return [...byId.values()];
}

export function PluginsClient({ lang, initialPlugins }: { lang: DocsLang; initialPlugins: MarketplacePlugin[] }) {
  const [plugins, setPlugins] = useState(initialPlugins);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const t = i18n[lang];

  useEffect(() => {
    let cancelled = false;
    fetchPluginCatalog({ cache: "no-cache" })
      .then((catalog) => {
        if (cancelled) return;
        if (catalog) setPlugins((current) => mergePlugins(current, catalog.plugins));
        else setRefreshFailed(true);
      })
      .catch(() => {
        if (!cancelled) setRefreshFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="min-h-screen bg-landing-bg text-landing-ink">
      <LandingNav lang={lang} active="plugins" />

      <section className="max-w-[1180px] mx-auto px-6 pt-32 pb-24">
        <h1 className="text-4xl font-[820] tracking-tight">{t.title}</h1>

        {refreshFailed && <p className="mt-4 text-[13px] text-landing-muted">{t.refreshError}</p>}

        {plugins.length === 0 ? (
          <div className="mt-10 rounded-xl border border-landing-line bg-landing-panel p-8 text-center">
            <p className="text-xl font-[720]">{t.emptyTitle}</p>
            <p className="mt-2 text-sm text-landing-muted">{t.emptyDesc}</p>
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-3 gap-5 max-[1040px]:grid-cols-2 max-[720px]:grid-cols-1">
            {plugins.map((plugin) => {
              const latest = latestPluginVersion(plugin);
              return (
                <div
                  key={plugin.id}
                  className="group relative flex flex-col rounded-xl border border-landing-line bg-landing-panel p-6 transition-colors hover:border-landing-blue"
                >
                  {/* Stretched link: the whole card navigates; interactive children sit above it. */}
                  <Link
                    href={`/${lang}/plugins/${plugin.id}`}
                    prefetch={false}
                    className="absolute inset-0 z-[1] rounded-xl"
                    aria-label={`${t.viewPlugin}: ${pluginDisplayName(plugin, lang)}`}
                  />
                  <div className="flex items-start gap-4">
                    <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white">
                      {plugin.icon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={plugin.icon} alt="" aria-hidden="true" width={40} height={40} className="size-10 object-contain" />
                      ) : null}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-x-2.5">
                        <h2 className="truncate text-[19px] font-[760]">{pluginDisplayName(plugin, lang)}</h2>
                        {latest ? <span className="shrink-0 rounded-md border border-landing-line px-1.5 py-0.5 text-[11px] font-[650] text-landing-muted">v{latest.version}</span> : null}
                      </div>
                      <p className="mt-0.5 text-[13px] text-landing-muted">
                        {plugin.publisher}
                        {plugin.license ? ` · ${plugin.license}` : ""}
                      </p>
                    </div>
                  </div>
                  <p className="mt-3.5 line-clamp-2 text-sm leading-[1.7] text-landing-muted">{pluginDisplayDescription(plugin, lang)}</p>
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-4">
                    {(plugin.tags ?? []).slice(0, 5).map((tag) => (
                      <span key={tag} className="rounded-md bg-landing-soft px-2 py-0.5 text-[11px] font-medium text-landing-muted">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-10 rounded-xl border border-landing-line bg-landing-panel">
          <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5">
            <div className="max-w-[640px]">
              <h2 className="text-xl font-[720]">{t.submitTitle}</h2>
              <p className="mt-2 text-sm leading-[1.7] text-landing-muted">{t.submitDesc}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={DBX_STORE_CONTRIBUTING_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center rounded-lg bg-[#f0f1f4] px-4 text-[13px] font-[720] text-[#0a0b0e] transition hover:bg-white"
              >
                {t.submitAction}
              </a>
              <Link
                href={`/${lang}/docs/plugin-development`}
                prefetch={false}
                className="inline-flex h-10 items-center rounded-lg border border-landing-line px-4 text-[13px] font-[650] text-landing-muted transition-colors hover:border-landing-blue hover:text-landing-ink"
              >
                {t.submitDocs}
              </Link>
            </div>
          </div>
        </div>
      </section>

      <LandingFooter lang={lang} />
    </main>
  );
}
