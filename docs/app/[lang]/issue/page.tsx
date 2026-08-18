import type { Metadata } from "next";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingNav } from "@/components/landing/LandingNav";
import { IssueSubmissionClient } from "@/components/issues/IssueSubmissionClient";
import { buildMetadata } from "@/lib/metadata";

const metadata = {
  en: {
    title: "Submit an Issue",
    description: "Describe a DBX problem or suggestion without a GitHub account. Review the AI-polished draft before publishing.",
  },
  cn: {
    title: "匿名提交 Issue",
    description: "无需 GitHub 账号，简短描述 DBX 问题或建议，由 AI 整理并在你确认后公开提交。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const locale = lang === "cn" ? "cn" : "en";
  const pageMetadata = buildMetadata({
    title: metadata[locale].title,
    description: metadata[locale].description,
    path: `/${locale}/issue`,
    lang: locale,
  });
  return {
    ...pageMetadata,
    robots: {
      index: false,
      follow: false,
      nocache: true,
    },
  };
}

export default async function IssuePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const locale = lang === "cn" ? "cn" : "en";

  return (
    <main className="issue-page min-h-screen text-landing-ink">
      <LandingNav lang={locale} active="issue" />
      <IssueSubmissionClient lang={locale} />
      <LandingFooter lang={locale} />
    </main>
  );
}
