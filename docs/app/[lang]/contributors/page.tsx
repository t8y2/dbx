import type { Metadata } from "next";
import contributorSnapshot from "@/data/contributors.json";
import { ContributorsExperience } from "@/components/contributors/ContributorsExperience";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingNav } from "@/components/landing/LandingNav";
import type { ContributorActivityData } from "@/lib/contributorActivity";
import { SITE_URL } from "@/lib/metadata";

const pageMetadata = {
  en: {
    title: "DBX Contributors",
    description: "Explore the people building DBX and download a certificate generated from public GitHub activity.",
  },
  cn: {
    title: "DBX 贡献者",
    description: "查看共同建设 DBX 的开源贡献者，并根据公开 GitHub 活动生成贡献证书。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const locale = lang === "cn" ? "cn" : "en";
  const metadata = pageMetadata[locale];

  return {
    ...metadata,
    alternates: {
      canonical: `${SITE_URL}/${locale}/contributors`,
      languages: {
        en: `${SITE_URL}/en/contributors`,
        zh: `${SITE_URL}/cn/contributors`,
        "x-default": `${SITE_URL}/en/contributors`,
      },
    },
    openGraph: {
      title: metadata.title,
      description: metadata.description,
      url: `${SITE_URL}/${locale}/contributors`,
    },
  };
}

export default async function ContributorsPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const locale = lang === "cn" ? "cn" : "en";
  const data = contributorSnapshot as ContributorActivityData;

  return (
    <main className="landing min-h-screen bg-[#061016]">
      <LandingNav lang={locale} active="contributors" />
      <ContributorsExperience data={data} lang={locale} />
      <LandingFooter lang={locale} />
    </main>
  );
}
