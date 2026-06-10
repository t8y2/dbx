import { LandingNav } from "@/components/landing/LandingNav";
import { ChangelogRuntime } from "@/components/landing/ChangelogRuntime";
import { fetchChangelog } from "@/lib/changelog";
import { buildMetadata } from "@/lib/metadata";
import type { Metadata } from "next";

const i18n = {
  en: {
    title: "Changelog",
    desc: "Track every release — features, improvements, and fixes.",
  },
  cn: {
    title: "更新日志",
    desc: "追踪每次发布 — 新功能、改进和修复。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = lang === "cn" ? "cn" : "en";
  const t = i18n[l];

  return buildMetadata({
    title: t.title,
    description: t.desc,
    path: `/${l}/changelog`,
    lang: l,
  });
}

export default async function ChangelogPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const l = lang === "cn" ? "cn" : "en";
  const t = i18n[l];
  const initialData = await fetchChangelog(l);

  return (
    <div className="min-h-screen bg-[#0b1120] text-landing-ink">
      <LandingNav lang={l} active="changelog" />

      <div className="max-w-[860px] mx-auto px-6 pt-32 pb-4">
        <h1 className="text-4xl font-[820] tracking-tight">{t.title}</h1>
        <p className="mt-3 text-landing-muted text-lg">{t.desc}</p>
      </div>

      <div className="max-w-[860px] mx-auto px-6 pb-24">
        <ChangelogRuntime lang={l} initialReleases={initialData.releases} />
      </div>
    </div>
  );
}
