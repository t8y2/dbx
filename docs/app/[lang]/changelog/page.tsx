import { LandingNav } from "@/components/landing/LandingNav";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { ChangelogRuntime } from "@/components/landing/ChangelogRuntime";
import { loadChangelogBootstrap } from "@/lib/changelog";
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
  const initialData = await loadChangelogBootstrap(l);

  return (
    <main className="min-h-screen bg-[#08080a] text-landing-ink">
      <LandingNav lang={l} active="changelog" />

      {/* 视觉隐藏：页面不再展示大标题，但保留语义 landmark 与 SEO */}
      <h1 className="sr-only">{t.title}</h1>

      <div className="max-w-[1400px] mx-auto px-7 pt-28 pb-24 max-[760px]:px-[18px] max-[760px]:pt-24">
        <ChangelogRuntime lang={l} index={initialData.index} initialRelease={initialData.initialRelease} fallbackReleases={initialData.fallbackReleases} />
      </div>

      <LandingFooter lang={l} />
    </main>
  );
}
