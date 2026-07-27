import type { Metadata } from "next";
import Link from "next/link";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingNav } from "@/components/landing/LandingNav";
import { buildMetadata } from "@/lib/metadata";

const i18n = {
  en: {
    title: "Sponsors & Partners",
    desc: "Thank you to the sponsors and partners supporting DBX through funding, resources, services, and collaboration.",
    sponsorDesc: "RainYun is a cloud service provider offering cloud servers, physical servers, game hosting, and developer-friendly infrastructure services.",
    sponsorAction: "Visit RainYun",
    becomeTitle: "Support DBX",
    becomeDesc: "Financial sponsorship, infrastructure, developer tools, services, and other forms of support are all welcome from individuals and organizations.",
    becomeContact: "QQ: 86554840",
    becomeAction: "Contact us",
  },
  cn: {
    title: "赞助商与合作伙伴",
    desc: "感谢赞助商与合作伙伴通过资金、资源、服务和协作等方式支持 DBX 持续发展。",
    sponsorDesc: "雨云是面向开发者和站长的云服务提供商，提供云服务器、物理服务器、游戏云和配套基础设施服务。",
    sponsorAction: "访问雨云",
    becomeTitle: "支持 DBX",
    becomeDesc: "无论是个人还是团队，资金赞助、基础设施、开发工具、服务资源或其他形式的支持都十分欢迎。",
    becomeContact: "QQ：86554840",
    becomeAction: "联系赞助合作",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const locale = lang === "cn" ? "cn" : "en";
  const t = i18n[locale];

  return buildMetadata({
    title: t.title,
    description: t.desc,
    path: `/${locale}/sponsors`,
    lang: locale,
  });
}

export default async function SponsorsPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const locale = lang === "cn" ? "cn" : "en";
  const t = i18n[locale];

  return (
    <main className="min-h-screen bg-[#0b1120] text-landing-ink">
      <LandingNav lang={locale} active="sponsors" />

      <section className="max-w-[860px] mx-auto px-6 pt-32 pb-24">
        <h1 className="text-4xl font-[820] tracking-tight">{t.title}</h1>
        <p className="mt-3 max-w-[700px] text-landing-muted text-lg leading-relaxed">{t.desc}</p>

        <div className="mt-10 rounded-xl border border-landing-line bg-landing-panel p-6">
          <div className="flex items-center gap-6 max-[640px]:block">
            <Link href="https://www.rainyun.com/MTE5Mjc4Ng==_" target="_blank" className="flex h-24 w-44 shrink-0 items-center justify-center rounded-lg bg-white px-5 shadow-[0_10px_30px_rgba(15,23,42,0.08)] max-[640px]:w-max">
              <img src="https://www.rainyun.com/img/logo.d193755d.png" alt="RainYun" className="h-12 w-auto max-w-[150px]" />
            </Link>
            <div className="min-w-0 max-[640px]:mt-5">
              <h2 className="text-2xl font-[760]">RainYun</h2>
              <p className="mt-2 text-sm leading-[1.7] text-landing-muted">{t.sponsorDesc}</p>
              <Link href="https://www.rainyun.com/MTE5Mjc4Ng==_" target="_blank" className="landing-inline-link mt-4 inline-flex items-center gap-[7px] text-sm font-[650]">
                {t.sponsorAction}
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-10 rounded-xl border border-landing-line bg-landing-panel px-6 py-5">
          <h2 className="text-xl font-[720]">{t.becomeTitle}</h2>
          <p className="mt-2 text-sm leading-[1.7] text-landing-muted">{t.becomeDesc}</p>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <span className="text-sm font-[650] text-landing-muted">{t.becomeContact}</span>
            <Link href="https://github.com/t8y2/dbx/discussions" target="_blank" className="landing-final-link inline-flex min-h-[42px] items-center justify-center rounded-[7px] px-4 text-sm font-[650]">
            {t.becomeAction}
            </Link>
          </div>
        </div>
      </section>

      <LandingFooter lang={locale} />
    </main>
  );
}
