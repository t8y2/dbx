import type { Metadata } from "next";
import Link from "next/link";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingNav } from "@/components/landing/LandingNav";
import { SponsorContactForm } from "@/components/landing/SponsorContactForm";
import { buildMetadata } from "@/lib/metadata";

const i18n = {
  en: {
    title: "Sponsors & Partners",
    desc: "Thank you to the sponsors and partners supporting DBX through funding, resources, services, and collaboration.",
    qiniuSponsorDesc: "Qiniu Cloud provides DBX with object storage, CDN, and other cloud infrastructure resources.",
    qiniuSponsorAction: "Visit Qiniu Cloud",
    rainyunSponsorDesc: "RainYun is a cloud service provider offering cloud servers, physical servers, game hosting, and developer-friendly infrastructure services.",
    rainyunSponsorAction: "Visit RainYun",
    easysearchSponsorDesc: "Easysearch is an enterprise-grade distributed search engine compatible with Elasticsearch APIs, combining full-text, vector, geospatial search, real-time analytics, and AI capabilities in one platform.",
    easysearchSponsorAction: "Visit Easysearch",
    atlasCloudSponsorDesc: "Atlas Cloud gives developers one unified API for 400+ AI models across chat, image, video, and audio.",
    atlasCloudSponsorAction: "Visit Atlas Cloud",
    becomeTitle: "Sponsorship inquiries",
    becomeDesc: "If you would like to support DBX with funding, infrastructure, developer tools, or services, tell us about the idea and how to reach you.",
  },
  cn: {
    title: "赞助商与合作伙伴",
    desc: "感谢赞助商与合作伙伴通过资金、资源、服务和协作等方式支持 DBX 持续发展。",
    qiniuSponsorDesc: "七牛云为 DBX 提供对象存储、CDN 等云基础设施资源支持。",
    qiniuSponsorAction: "访问七牛云",
    rainyunSponsorDesc: "雨云是面向开发者和站长的云服务提供商，提供云服务器、物理服务器、游戏云和配套基础设施服务。",
    rainyunSponsorAction: "访问雨云",
    easysearchSponsorDesc: "Easysearch 是一款企业级分布式搜索引擎，兼容 ES API、融合全文检索、向量检索、地理空间位置检索、实时分析与 AI 能力，为企业提供统一的数据检索与智能分析基础设施。",
    easysearchSponsorAction: "访问 Easysearch",
    atlasCloudSponsorDesc: "Atlas Cloud 为开发者提供统一的多模态 AI API，可通过一个接口访问聊天、图像、视频和音频等 400+ 模型。",
    atlasCloudSponsorAction: "访问 Atlas Cloud",
    becomeTitle: "赞助合作",
    becomeDesc: "如果你愿意通过资金、基础设施、开发工具或服务资源支持 DBX，请留下联系方式和合作说明。",
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
  const sponsorItems = [
    {
      name: "RainYun",
      href: "https://www.rainyun.com/MTE5Mjc4Ng==_",
      logo: "https://www.rainyun.com/img/logo.d193755d.png",
      logoClass: "h-12 w-auto max-w-[150px]",
      description: t.rainyunSponsorDesc,
      action: t.rainyunSponsorAction,
    },
    {
      name: locale === "cn" ? "七牛云" : "Qiniu Cloud",
      href: "https://www.qiniu.com/",
      logo: "https://www-static.qbox.me/_next/static/media/logo.0fc18feaa621d2068a7180631f742256.jpg",
      logoClass: "h-16 w-16 object-contain",
      description: t.qiniuSponsorDesc,
      action: t.qiniuSponsorAction,
    },
    {
      name: "Easysearch",
      href: "https://easysearch.cn",
      logo: "/sponsors/easysearch.png",
      logoClass: "w-full max-w-[136px] object-contain",
      description: t.easysearchSponsorDesc,
      action: t.easysearchSponsorAction,
    },
    {
      name: "Atlas Cloud",
      href: "https://www.atlascloud.ai/?ref=6YYXWA",
      logo: "https://www.atlascloud.ai/logo.svg",
      logoClass: "w-full max-w-[136px] object-contain",
      description: t.atlasCloudSponsorDesc,
      action: t.atlasCloudSponsorAction,
    },
  ];

  return (
    <main className="min-h-screen bg-[#0b1120] text-landing-ink">
      <LandingNav lang={locale} active="sponsors" />

      <section className="max-w-[860px] mx-auto px-6 pt-32 pb-24">
        <h1 className="text-4xl font-[820] tracking-tight">{t.title}</h1>
        <p className="mt-3 max-w-[700px] text-landing-muted text-lg leading-relaxed">{t.desc}</p>

        <div className="mt-10 grid gap-4">
          {sponsorItems.map((sponsor) => (
            <div key={sponsor.name} className="rounded-xl border border-landing-line bg-landing-panel p-6">
              <div className="flex items-center gap-6 max-[640px]:block">
                <Link href={sponsor.href} target="_blank" className="flex h-24 w-44 shrink-0 items-center justify-center rounded-lg bg-white px-5 shadow-[0_10px_30px_rgba(15,23,42,0.08)] max-[640px]:w-max">
                  <img src={sponsor.logo} alt={sponsor.name} className={sponsor.logoClass} />
                </Link>
                <div className="min-w-0 max-[640px]:mt-5">
                  <h2 className="text-2xl font-[760]">{sponsor.name}</h2>
                  <p className="mt-2 text-sm leading-[1.7] text-landing-muted">{sponsor.description}</p>
                  <Link href={sponsor.href} target="_blank" className="landing-inline-link mt-4 inline-flex items-center gap-[7px] text-sm font-[650]">
                    {sponsor.action}
                    <span aria-hidden="true">→</span>
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10 overflow-hidden rounded-xl border border-landing-line bg-landing-panel">
          <div className="border-b border-landing-line px-6 py-5">
            <h2 className="text-xl font-[720]">{t.becomeTitle}</h2>
            <p className="mt-2 max-w-[680px] text-sm leading-[1.7] text-landing-muted">{t.becomeDesc}</p>
          </div>
          <div className="p-6">
            <SponsorContactForm lang={locale} />
          </div>
        </div>
      </section>

      <LandingFooter lang={locale} />
    </main>
  );
}
