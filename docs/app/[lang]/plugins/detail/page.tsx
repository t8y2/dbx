import type { Metadata } from "next";
import { resolveLang } from "@/lib/i18n";
import { PluginDetailClient } from "../[id]/PluginDetailClient";

// Shell route for the worker fallback: pretty /plugins/<id> URLs missing from the
// build snapshot are served this page, which reads the id from ?id= and renders
// the detail view client-side. Keep noindex — real plugin pages are baked at build.
export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = resolveLang(lang);

  return {
    title: "Plugin",
    robots: { index: false, follow: false },
    alternates: { canonical: `/${l}/plugins` },
  };
}

export default async function PluginDetailShellPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const l = resolveLang(lang);

  return <PluginDetailClient lang={l} id={null} initialPlugin={null} />;
}
