import type { Metadata } from "next";
import { fetchPluginCatalog } from "@/lib/pluginCatalog";
import { fetchPluginInstalls } from "@/lib/pluginStats";
import { buildMetadata } from "@/lib/metadata";
import { resolveLang } from "@/lib/i18n";
import { PluginsClient } from "./PluginsClient";

const pageMeta = {
  en: {
    title: "Plugin Center",
    description: "Browse official DBX marketplace plugins: signed packages, versions, permissions, and one-click install URLs for the in-app plugin center.",
  },
  cn: {
    title: "插件中心",
    description: "浏览 DBX 官方插件商店收录的插件：签名校验的安装包、版本历史、权限说明，以及可直接粘贴到客户端插件中心的安装链接。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = resolveLang(lang);
  const meta = pageMeta[l];

  return buildMetadata({
    title: meta.title,
    description: meta.description,
    path: `/${l}/plugins`,
    lang: l,
    ogType: "website",
  });
}

export default async function PluginsPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const l = resolveLang(lang);
  // Build-time snapshot for instant paint and SEO; the client refreshes it from R2 on mount.
  // Dev serves fresh data — force-cache would pin a stale entry from .next across sessions.
  const snapshotCache: RequestCache = process.env.NODE_ENV === "production" ? "force-cache" : "no-store";
  const catalog = await fetchPluginCatalog({ cache: snapshotCache });
  // Install counters are decorative: a null snapshot just renders cards without counts.
  const installs = await fetchPluginInstalls({ cache: snapshotCache });

  return <PluginsClient lang={l} initialPlugins={catalog?.plugins ?? []} initialInstalls={installs} />;
}
