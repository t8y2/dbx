import type { Metadata } from "next";
import Link from "next/link";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingNav } from "@/components/landing/LandingNav";
import { SponsorContactForm } from "@/components/landing/SponsorContactForm";
import { buildMetadata } from "@/lib/metadata";
import { resolveLang } from "@/lib/i18n";

const i18n = {
  en: {
    title: "Sponsors & Partners",
    desc: "Thank you to the sponsors and partners supporting DBX through funding, resources, services, and collaboration.",
    sponsorsTitle: "❤️ Sponsors",
    partnersTitle: "🤝 Partners",
    qiniuSponsorDesc: "Qiniu Cloud provides DBX with object storage, CDN, and other cloud infrastructure resources.",
    qiniuSponsorAction: "Visit",
    rainyunSponsorDesc: "RainYun is a cloud service provider offering cloud servers, physical servers, game hosting, and developer-friendly infrastructure services.",
    rainyunSponsorAction: "Visit",
    easysearchSponsorDesc: "Easysearch is an enterprise-grade distributed search engine compatible with Elasticsearch APIs, combining full-text, vector, geospatial search, real-time analytics, and AI capabilities in one platform.",
    easysearchSponsorAction: "Visit",
    atlasCloudSponsorDesc: "Atlas Cloud gives developers one unified API for 400+ AI models across chat, image, video, and audio.",
    atlasCloudSponsorAction: "Visit",
    trustasiaSponsorDesc: "TrustAsia provides cloud-based code signing service for DBX, enabling trusted software through automated CI/CD builds.",
    trustasiaSponsorAction: "Visit",
    jalapenoSponsorDesc: "Jalapeño Cloud is an AI infrastructure and token compute platform, with an exclusive DBX entry offering free credits and top-up bonuses.",
    jalapenoSponsorAction: "Visit",
    astraflowSponsorDesc: "UCloud is the first public cloud provider listed on China's STAR Market, with 28 global regions for cloud hosting, databases, and CDN; its AstraFlow platform offers one-click access to 200+ mainstream LLMs.",
    astraflowSponsorAction: "Visit",
    onepanelSponsorDesc: "1Panel is a modern open-source Linux server management panel and lightweight AI management platform, offering an intuitive web interface for one-stop management of AI agents, local LLMs, websites, databases, containers, files, and more.",
    onepanelSponsorAction: "Visit",
    hualongSponsorDesc: "HuaLongAI is a model API relay built for heavy AI developers, offering 100% official-source Codex and Claude models with transparent token-level billing, enterprise contracts, and invoicing.",
    hualongSponsorAction: "Visit",
    becomeTitle: "Sponsorship inquiries",
    becomeDesc: "If you would like to support DBX with funding, infrastructure, developer tools, or services, tell us about the idea and how to reach you.",
  },
  tr: {
    title: "Sponsorlar ve İş Ortakları",
    desc: "DBX'i finansman, kaynak, hizmet ve iş birliğiyle destekleyen sponsorlara ve iş ortaklarına teşekkür ederiz.",
    sponsorsTitle: "❤️ Sponsorlar",
    partnersTitle: "🤝 İş Ortakları",
    qiniuSponsorDesc: "Qiniu Cloud, DBX'e nesne depolama, CDN ve diğer bulut altyapı kaynaklarını sağlıyor.",
    qiniuSponsorAction: "Ziyaret edin",
    rainyunSponsorDesc: "RainYun; bulut sunucular, fiziksel sunucular, oyun barındırma ve geliştirici dostu altyapı hizmetleri sunan bir bulut servis sağlayıcısıdır.",
    rainyunSponsorAction: "Ziyaret edin",
    easysearchSponsorDesc: "Easysearch, Elasticsearch API'leriyle uyumlu kurumsal düzeyde dağıtık bir arama motorudur; tam metin, vektör ve coğrafi aramayı, gerçek zamanlı analitiği ve yapay zekâ yeteneklerini tek platformda birleştirir.",
    easysearchSponsorAction: "Ziyaret edin",
    atlasCloudSponsorDesc: "Atlas Cloud, geliştiricilere sohbet, görsel, video ve ses alanlarında 400+ yapay zekâ modeli için tek ve birleşik bir API sunar.",
    atlasCloudSponsorAction: "Ziyaret edin",
    trustasiaSponsorDesc: "TrustAsia, DBX için bulut tabanlı kod imzalama hizmeti sağlayarak otomatik CI/CD derlemeleriyle güvenilir yazılım üretilmesini sağlıyor.",
    trustasiaSponsorAction: "Ziyaret edin",
    jalapenoSponsorDesc: "Jalapeño Cloud, yapay zekâ altyapısı ve belirteç hesaplama platformudur; DBX'e özel giriş noktasıyla ücretsiz kredi ve yükleme bonusu sunar.",
    jalapenoSponsorAction: "Ziyaret edin",
    astraflowSponsorDesc: "UCloud, Çin'in STAR Market borsasına kote ilk genel bulut sağlayıcısıdır; 28 küresel bölgede bulut sunucu, veritabanı ve CDN hizmeti verir. AstraFlow platformu 200+ yaygın büyük dil modeline tek tıklamayla erişim sağlar.",
    astraflowSponsorAction: "Ziyaret edin",
    onepanelSponsorDesc: "1Panel, modern, açık kaynaklı bir Linux sunucu yönetim paneli ve hafif yapay zekâ yönetim platformudur; yapay zekâ ajanları, yerel büyük dil modelleri, web siteleri, veritabanları, konteynerler ve dosyaları tek web arayüzünden yönetir.",
    onepanelSponsorAction: "Ziyaret edin",
    hualongSponsorDesc: "HuaLongAI, yoğun yapay zekâ geliştiricileri için bir model API aktarıcısıdır; %100 resmî kaynaktan Codex ve Claude modelleri, şeffaf belirteç düzeyinde faturalandırma, kurumsal sözleşme ve fatura sunar.",
    hualongSponsorAction: "Ziyaret edin",
    becomeTitle: "Sponsorluk başvurusu",
    becomeDesc: "DBX'i finansman, altyapı, geliştirici araçları veya hizmetlerle desteklemek isterseniz fikrinizi ve size nasıl ulaşabileceğimizi yazın.",
  },
  cn: {
    title: "赞助商与合作伙伴",
    desc: "感谢赞助商与合作伙伴通过资金、资源、服务和协作等方式支持 DBX 持续发展。",
    sponsorsTitle: "❤️ 赞助商",
    partnersTitle: "🤝 合作伙伴",
    qiniuSponsorDesc: "七牛云为 DBX 提供对象存储、CDN 等云基础设施资源支持。",
    qiniuSponsorAction: "访问",
    rainyunSponsorDesc: "雨云是面向开发者和站长的云服务提供商，提供云服务器、物理服务器、游戏云和配套基础设施服务。",
    rainyunSponsorAction: "访问",
    easysearchSponsorDesc: "Easysearch 是一款企业级分布式搜索引擎，兼容 ES API、融合全文检索、向量检索、地理空间位置检索、实时分析与 AI 能力，为企业提供统一的数据检索与智能分析基础设施。",
    easysearchSponsorAction: "访问",
    atlasCloudSponsorDesc: "Atlas Cloud 为开发者提供统一的多模态 AI API，可通过一个接口访问聊天、图像、视频和音频等 400+ 模型。",
    atlasCloudSponsorAction: "访问",
    trustasiaSponsorDesc: "由 TrustAsia 提供代码签名云签服务，实现 CICD 自动化构建可信软件。",
    trustasiaSponsorAction: "访问",
    jalapenoSponsorDesc: "Jalapeño Cloud 是 AI 基础设施与 Token 算力平台，通过 DBX 专属入口可享新用户免费额度与充值加赠。",
    jalapenoSponsorAction: "访问",
    astraflowSponsorDesc: "UCloud 优刻得是国内首家公有云科创板上市公司，覆盖国内、亚洲、欧洲、北美等 28 个地域的云主机、数据库、CDN 等服务，注册享新客优惠 0.9 折起；星图 AstraFlow 大模型平台支持主流 200+ 大模型一键调用。",
    astraflowSponsorAction: "访问",
    onepanelSponsorDesc: "1Panel 是现代化的开源 Linux 服务器运维管理面板与轻量级 AI 管理平台，提供直观易用的 Web 界面，支持 AI 智能体、本地大模型、网站、数据库、容器、文件等核心场景的一站式管理。",
    onepanelSponsorAction: "访问",
    hualongSponsorDesc: "HuaLongAI（华龙算力）是面向重度 AI 开发者的模型 API 中转服务商，主营 Codex 与 Claude 系列模型，100% 官方源直供、不掺假；计费透明，Token 级账单可逐笔核验，支持企业合同与发票。",
    hualongSponsorAction: "访问",
    becomeTitle: "赞助合作",
    becomeDesc: "如果你愿意通过资金、基础设施、开发工具或服务资源支持 DBX，请留下联系方式和合作说明。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const locale = resolveLang(lang);
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
  const locale = resolveLang(lang);
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
      name: "TrustAsia",
      href: "https://www.trustasia.com/ssl/trustasia/code-signing",
      logo: "/sponsors/trustasia.png",
      logoClass: "w-full max-w-[160px] object-contain",
      description: t.trustasiaSponsorDesc,
      action: t.trustasiaSponsorAction,
    },
    {
      name: "Jalapeño Cloud",
      href: "https://www.jalapeno-cloud.ai/DBX",
      logo: "/sponsors/jalapeno-card.png",
      logoClass: "w-full max-w-[136px] object-contain",
      description: t.jalapenoSponsorDesc,
      action: t.jalapenoSponsorAction,
    },
    {
      name: "AstraFlow",
      href: "https://www.ucloud.cn/site/active/kuaijiesale.html?ytag=geo_waituo_github_dbx",
      logo: "/sponsors/astraflow-card.png",
      logoClass: "w-full max-w-[136px] object-contain",
      description: t.astraflowSponsorDesc,
      action: t.astraflowSponsorAction,
    },
    {
      name: "HuaLongAI",
      href: "https://api.hualong.online/",
      logo: "/sponsors/hualong-card.png",
      logoClass: "w-full max-w-[160px] object-contain",
      description: t.hualongSponsorDesc,
      action: t.hualongSponsorAction,
    },
    {
      name: "Atlas Cloud",
      href: "https://www.atlascloud.ai/?ref=6YYXWA",
      logo: "https://www.atlascloud.ai/logo.svg",
      logoClass: "w-full max-w-[136px] object-contain",
      description: t.atlasCloudSponsorDesc,
      action: t.atlasCloudSponsorAction,
    },
    {
      name: locale === "cn" ? "七牛云" : "Qiniu Cloud",
      href: "https://www.qiniu.com/",
      logo: "https://www-static.qbox.me/_next/static/media/logo.0fc18feaa621d2068a7180631f742256.jpg",
      logoClass: "h-16 w-16 object-contain",
      description: t.qiniuSponsorDesc,
      action: t.qiniuSponsorAction,
    },
  ];
  const partnerItems = [
    {
      name: "1Panel",
      href: "https://1panel.cn/",
      logo: "/sponsors/1panel-card.png",
      logoClass: "w-full max-w-[136px] object-contain",
      description: t.onepanelSponsorDesc,
      action: t.onepanelSponsorAction,
    },
    {
      name: "Easysearch",
      href: "https://easysearch.cn",
      logo: "/sponsors/easysearch.png",
      logoClass: "w-full max-w-[136px] object-contain",
      description: t.easysearchSponsorDesc,
      action: t.easysearchSponsorAction,
    },
  ];

  return (
    <main className="min-h-screen bg-[#08080a] text-landing-ink">
      <LandingNav lang={locale} active="sponsors" />

      <section className="max-w-[1180px] mx-auto px-6 pt-32 pb-24">
        <h1 className="text-4xl font-[820] tracking-tight">{t.title}</h1>
        <p className="mt-3 max-w-[700px] text-landing-muted text-lg leading-relaxed">{t.desc}</p>

        <h2 className="mt-10 text-2xl font-[760]">{t.sponsorsTitle}</h2>
        <div className="mt-5 grid grid-cols-2 gap-5 max-[900px]:grid-cols-1">
          {sponsorItems.map((sponsor) => (
            <Link key={sponsor.name} href={sponsor.href} target="_blank" rel="noopener noreferrer" className="block rounded-xl border border-landing-line bg-landing-panel p-6 transition-colors hover:border-landing-blue">
              <div className="flex items-center gap-6 max-[640px]:block">
                <div className="flex h-24 w-44 shrink-0 items-center justify-center rounded-lg bg-white px-5 shadow-[0_10px_30px_rgba(15,23,42,0.08)] max-[640px]:w-max">
                  <img src={sponsor.logo} alt={sponsor.name} className={sponsor.logoClass} />
                </div>
                <div className="min-w-0 max-[640px]:mt-5">
                  <div className="flex items-center gap-x-3">
                    <h3 className="text-2xl font-[760]">{sponsor.name}</h3>
                    <span className="landing-inline-link ml-auto inline-flex shrink-0 items-center gap-[7px] text-sm font-[650]">
                      {sponsor.action}
                      <span aria-hidden="true">→</span>
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-[1.7] text-landing-muted">{sponsor.description}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>

        <h2 className="mt-12 text-2xl font-[760]">{t.partnersTitle}</h2>
        <div className="mt-5 grid grid-cols-2 gap-5 max-[900px]:grid-cols-1">
          {partnerItems.map((sponsor) => (
            <Link key={sponsor.name} href={sponsor.href} target="_blank" rel="noopener noreferrer" className="block rounded-xl border border-landing-line bg-landing-panel p-6 transition-colors hover:border-landing-blue">
              <div className="flex items-center gap-6 max-[640px]:block">
                <div className="flex h-24 w-44 shrink-0 items-center justify-center rounded-lg bg-white px-5 shadow-[0_10px_30px_rgba(15,23,42,0.08)] max-[640px]:w-max">
                  <img src={sponsor.logo} alt={sponsor.name} className={sponsor.logoClass} />
                </div>
                <div className="min-w-0 max-[640px]:mt-5">
                  <div className="flex items-center gap-x-3">
                    <h3 className="text-2xl font-[760]">{sponsor.name}</h3>
                    <span className="landing-inline-link ml-auto inline-flex shrink-0 items-center gap-[7px] text-sm font-[650]">
                      {sponsor.action}
                      <span aria-hidden="true">→</span>
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-[1.7] text-landing-muted">{sponsor.description}</p>
                </div>
              </div>
            </Link>
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
