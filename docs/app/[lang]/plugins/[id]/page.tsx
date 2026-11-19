import type { Metadata } from "next";
import { DEFAULT_DESCRIPTION } from "@/lib/metadata";
import { fetchPluginCatalog, pluginDisplayDescription, pluginMetadataTitle } from "@/lib/pluginCatalog";
import { buildMetadata } from "@/lib/metadata";
import { resolveLang } from "@/lib/i18n";
import { PluginDetailClient } from "./PluginDetailClient";

// Reserved slug served by the worker for plugin pages missing from the build snapshot.
const SHELL_SLUG = "detail";

type PageParams = { params: Promise<{ lang: string; id: string }> };

async function findSnapshotCatalog() {
  return fetchPluginCatalog({ cache: "force-cache" });
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { lang, id } = await params;
  const l = resolveLang(lang);
  const catalog = await findSnapshotCatalog();
  const plugin = catalog?.plugins.find((entry) => entry.id === id) ?? null;

  return buildMetadata({
    title: plugin ? pluginMetadataTitle(plugin, l, catalog) : "Plugin",
    description: plugin ? pluginDisplayDescription(plugin, l) : DEFAULT_DESCRIPTION,
    path: `/${l}/plugins/${id}`,
    lang: l,
    ogType: "website",
  });
}

export async function generateStaticParams() {
  const catalog = await fetchPluginCatalog({ cache: "force-cache" });
  return (catalog?.plugins ?? [])
    .map((plugin) => plugin.id)
    .filter((id) => id !== SHELL_SLUG)
    .map((id) => ({ id }));
}

export default async function PluginDetailPage({ params }: PageParams) {
  const { lang, id } = await params;
  const l = resolveLang(lang);
  // Unknown ids render the client shell, which resolves data from the live catalog;
  // exported pages always carry the build-time snapshot for instant paint and SEO.
  const catalog = await findSnapshotCatalog();
  const plugin = id === SHELL_SLUG ? null : (catalog?.plugins.find((entry) => entry.id === id) ?? null);

  return <PluginDetailClient lang={l} id={id} initialPlugin={plugin} />;
}
