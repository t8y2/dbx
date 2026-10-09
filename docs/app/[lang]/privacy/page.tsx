import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, Database, Globe2, Network, ShieldCheck } from "lucide-react";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingNav } from "@/components/landing/LandingNav";
import { resolveLang } from "@/lib/i18n";
import { buildMetadata } from "@/lib/metadata";

const copy = {
  en: {
    metadataTitle: "Privacy Policy",
    metadataDescription: "How the DBX application and dbxio.com handle local data, optional network features, website analytics, support submissions, retention, and security.",
    eyebrow: "Privacy",
    title: "Privacy Policy",
    lead: "DBX is local-first. The application does not require a DBX cloud account, and the project maintainers do not receive your database contents or credentials by default.",
    effectiveLabel: "Effective date",
    effectiveDate: "September 27, 2026",
    updatedLabel: "Last updated",
    updatedDate: "September 27, 2026",
    highlights: [
      {
        title: "Local by default",
        description: "Application settings, saved SQL, connection definitions, and protected secrets stay in the DBX data directory you control.",
      },
      {
        title: "Network access is contextual",
        description: "DBX contacts databases and optional services only as required by the connections and features you configure or use.",
      },
      {
        title: "Website data is separate",
        description: "Website analytics, GitHub sign-in, and support submissions are described separately from data stored by your DBX installation.",
      },
    ],
    contentsLabel: "On this page",
    sections: [
      ["scope", "Scope"],
      ["application-data", "Application data"],
      ["network", "Network activity"],
      ["website", "Website services"],
      ["retention", "Retention and deletion"],
      ["security", "Security"],
      ["changes", "Changes and contact"],
    ],
    scopeTitle: "Scope and responsibility",
    scopeParagraphs: [
      "This policy covers the official DBX application, including desktop, Web, Docker, and NAS distributions, and the dbxio.com website operated for the DBX project.",
      "When you self-host DBX, you or your organization controls the deployment, users, databases, backups, and access policies. The DBX project is normally not the controller or processor of data stored inside that deployment.",
      "A database, AI provider, synchronization service, identity provider, plugin source, application store, or other third party you choose has its own terms and privacy practices.",
    ],
    applicationTitle: "Data stored by the DBX application",
    applicationIntro: "DBX stores the information needed to provide the features you enable. Depending on how you use it, this can include:",
    applicationBullets: [
      "Database connection definitions, application preferences, saved SQL, query-related workspace state, and backup metadata.",
      "Plugin settings, AI provider settings, SSH tunnel settings, and WebDAV or code-hosting synchronization settings.",
      "Credentials such as passwords, tokens, and private-key passphrases when you choose to save them.",
    ],
    applicationClosing: "Sensitive fields are protected by the DBX Secret Store before they are written to the application database. On Web, Docker, and NAS deployments, the encryption key and database are part of the same data-directory recovery unit. Anyone who can copy the complete application data volume may be able to copy both, so operating-system permissions, NAS access controls, and backup security remain important.",
    networkTitle: "When the application uses the network",
    networkIntro: "Not every installation uses every service below. Network requests occur when a configured feature needs them, or when you explicitly invoke that feature.",
    networkColumns: ["Feature", "Destination and possible data"],
    networkRows: [
      ["Database connections", "The database or data-service endpoint you configure. Protocol traffic can include credentials, queries, metadata, and returned data."],
      ["AI assistance", "The AI provider or compatible endpoint you select. Requests can include your prompt and the SQL, schema, error, selection, or other context needed for the requested task."],
      ["Synchronization", "The WebDAV, GitHub, or Gitee service you configure. DBX sends the synchronization package and the authentication information required by that service."],
      ["Plugins, drivers, and updates", "Official or user-configured download sources. Requests can reveal ordinary network metadata and the version, platform, package, plugin, or driver being requested."],
      ["OAuth and external authentication", "The identity provider required by the database or service you choose. The exchanged identity and tokens follow that provider's protocol and policy."],
    ],
    networkClosing: "DBX does not control how a destination service retains or uses data. Review the destination, minimize the context you send, use TLS where available, and do not send sensitive production data to a service you do not trust.",
    websiteTitle: "Data handled by dbxio.com",
    websiteItems: [
      {
        title: "Hosting and analytics",
        description: "The website loads an analytics script from analytics.unihub.top. Website hosting and analytics requests may process technical information normally sent by a browser, such as IP address, user agent, referrer, requested page, timestamp, and usage events, depending on the active service configuration.",
      },
      {
        title: "GitHub sign-in",
        description: "If you choose GitHub sign-in for a website feature, GitHub authenticates you and the site reads your GitHub login, avatar URL, and profile URL. The temporary OAuth access token is discarded after that public identity is read. A signed session cookie can remain for up to seven days.",
      },
      {
        title: "Issue drafting and submission",
        description: "The issue form sends the description and any screenshots you provide to the configured AI service to prepare a draft. A draft is kept for about 30 minutes, the anonymous issue session for up to 24 hours, and rate-limit records for about one hour. Nothing is published until you review and confirm the draft.",
      },
      {
        title: "Public support content",
        description: "After confirmation, the issue title, body, and uploaded images become public on GitHub and associated public image hosting. Do not submit passwords, tokens, private keys, connection strings, unredacted logs, customer data, or other confidential or personal information.",
      },
    ],
    retentionTitle: "Retention, export, and deletion",
    retentionParagraphs: [
      "Application data remains in the data directory, system credential store, configured synchronization destination, and backups until you or the system administrator removes it. Deleting a connection or configuration does not automatically erase independent backups or copies already synchronized to a third party.",
      "You can delete application records through DBX and remove the application data directory when uninstalling. Export anything you need before deletion. For fnOS and other application stores, the final removal behavior also depends on the choices and rules presented by that platform.",
      "Short-lived website authentication, draft, and rate-limit records expire as described above. Published GitHub Issues and images follow GitHub and hosting retention rules and may remain in caches, forks, notifications, or archives even after a deletion request. Operational logs and analytics data are retained according to the current hosting and analytics configuration for security, abuse prevention, and maintenance.",
    ],
    securityTitle: "Security boundaries",
    securityParagraphs: [
      "DBX uses safeguards such as encrypted secret storage, signed packages, sandboxing for supported plugin paths, and authenticated website sessions where applicable. No system can guarantee absolute security.",
      "Protect the device and data directory, restrict network exposure, use strong DBX and database credentials, keep DBX and its dependencies updated, verify third-party endpoints, and secure exported or synchronized data. If you operate DBX for other people, you are responsible for appropriate access control, notices, and legal compliance.",
    ],
    changesTitle: "Policy changes and contact",
    changesParagraphs: [
      "We may update this policy when DBX features, website services, or legal requirements change. The effective date at the top identifies the current version. Material changes should be reflected in the project website or release materials.",
      "For privacy or security questions, contact the DBX maintainers through the GitHub support channel. Do not include sensitive information in a public Issue; ask for an appropriate private contact path first if the request itself contains confidential details.",
    ],
    contactLabel: "Open the DBX support channel",
    closing: "This policy describes the official DBX project. A distributor or organization offering its own DBX service may provide additional terms that also apply.",
  },
  cn: {
    metadataTitle: "隐私政策",
    metadataDescription: "了解 DBX 应用和 dbxio.com 如何处理本地数据、可选联网功能、网站统计、支持提交、数据保留与安全边界。",
    eyebrow: "隐私",
    title: "隐私政策",
    lead: "DBX 采用本地优先设计。应用不要求注册 DBX 云账号，项目维护者默认不会收到你的数据库内容或数据库凭据。",
    effectiveLabel: "生效日期",
    effectiveDate: "2026 年 9 月 27 日",
    updatedLabel: "最后更新",
    updatedDate: "2026 年 9 月 27 日",
    highlights: [
      {
        title: "默认保存在本地",
        description: "应用设置、已保存 SQL、连接定义和受保护的敏感凭据保存在你控制的 DBX 数据目录中。",
      },
      {
        title: "联网取决于实际功能",
        description: "DBX 仅在连接你配置的系统，或使用你启用的在线功能时访问相应网络服务。",
      },
      {
        title: "网站数据单独说明",
        description: "网站统计、GitHub 登录和支持提交，与自托管 DBX 实例保存的数据具有不同边界。",
      },
    ],
    contentsLabel: "本页内容",
    sections: [
      ["scope", "适用范围"],
      ["application-data", "应用数据"],
      ["network", "联网行为"],
      ["website", "网站服务"],
      ["retention", "保留与删除"],
      ["security", "安全边界"],
      ["changes", "变更与联系"],
    ],
    scopeTitle: "适用范围与责任边界",
    scopeParagraphs: [
      "本政策适用于官方 DBX 应用，包括桌面端、Web、Docker 和 NAS 发行包，以及 DBX 项目运营的 dbxio.com 网站。",
      "当你自行部署 DBX 时，你或你的组织负责部署环境、使用者、数据库、备份和访问策略。DBX 项目通常不是该部署内数据库数据的控制者或处理者。",
      "你选择的数据库、AI 服务、同步服务、身份提供商、插件来源、应用商店或其他第三方，适用其各自的条款和隐私规则。",
    ],
    applicationTitle: "DBX 应用保存的数据",
    applicationIntro: "DBX 会保存提供已启用功能所需的信息。根据你的使用方式，可能包括：",
    applicationBullets: [
      "数据库连接定义、应用设置、已保存 SQL、查询相关工作区状态和备份元数据。",
      "插件设置、AI 服务设置、SSH Tunnel 设置，以及 WebDAV 或代码托管同步设置。",
      "在你选择保存时使用的密码、Token 和私钥口令等敏感凭据。",
    ],
    applicationClosing: "敏感字段写入应用数据库前会由 DBX Secret Store 保护。在 Web、Docker 和 NAS 部署中，加密密钥与数据库属于同一个数据目录恢复单元。能够复制完整应用数据卷的人员可能同时取得密文和密钥，因此仍需妥善设置操作系统权限、NAS 访问控制和备份权限。",
    networkTitle: "DBX 应用何时访问网络",
    networkIntro: "并非每个安装都会使用下列全部服务。只有已配置功能需要访问，或你主动调用相关功能时，才会产生对应网络请求。",
    networkColumns: ["功能", "访问目标与可能发送的数据"],
    networkRows: [
      ["数据库连接", "你配置的数据库或数据服务地址。协议流量可能包含凭据、查询、元数据和返回数据。"],
      ["AI 辅助", "你选择的 AI 服务商或兼容接口。请求可能包含提示词，以及完成任务所需的 SQL、Schema、错误信息、选中内容或其他上下文。"],
      ["配置同步", "你配置的 WebDAV、GitHub 或 Gitee 服务。DBX 会发送同步包及该服务所需的认证信息。"],
      ["插件、驱动与更新", "官方或用户配置的下载来源。请求可能暴露常规网络元数据，以及所请求的版本、平台、软件包、插件或驱动信息。"],
      ["OAuth 与外部认证", "所选数据库或服务要求的身份提供商。交换的身份信息和 Token 受该提供商协议与隐私规则约束。"],
    ],
    networkClosing: "DBX 无法控制目标服务如何保留或使用数据。请核对访问目标、尽量减少发送的上下文、在可用时使用 TLS，并避免把敏感生产数据发送给不可信的服务。",
    websiteTitle: "dbxio.com 处理的数据",
    websiteItems: [
      {
        title: "网站托管与访问统计",
        description: "网站会从 analytics.unihub.top 加载访问统计脚本。根据当前服务配置，网站托管和统计请求可能处理浏览器通常发送的技术信息，例如 IP 地址、User-Agent、来源页面、访问页面、时间和使用事件。",
      },
      {
        title: "GitHub 登录",
        description: "当你主动使用网站的 GitHub 登录功能时，认证由 GitHub 完成，网站会读取你的 GitHub 用户名、头像地址和个人主页地址。用于读取这些公开身份信息的临时 OAuth Token 随后会被丢弃，签名会话 Cookie 最长可保留 7 天。",
      },
      {
        title: "Issue 草稿与提交",
        description: "Issue 表单会把你填写的描述和上传的截图发送给已配置的 AI 服务，以生成可编辑草稿。草稿约保留 30 分钟，匿名 Issue 会话最长保留 24 小时，限流记录约保留 1 小时。只有你检查并确认后才会公开发布。",
      },
      {
        title: "公开支持内容",
        description: "确认提交后，Issue 标题、正文和上传图片会在 GitHub 及关联的公开图片地址上公开。请勿提交密码、Token、私钥、连接字符串、未脱敏日志、客户数据或其他机密和个人信息。",
      },
    ],
    retentionTitle: "数据保留、导出与删除",
    retentionParagraphs: [
      "应用数据会保留在数据目录、系统凭据库、已配置的同步目标和备份中，直到你或系统管理员将其删除。删除连接或配置，不会自动清除独立备份或已同步到第三方的副本。",
      "你可以在 DBX 中删除应用记录，也可以在卸载时移除应用数据目录；删除前请先导出需要保留的内容。对于飞牛 fnOS 等应用商店，最终的数据移除行为还取决于平台卸载界面提供的选项和系统规则。",
      "短期的网站认证、草稿和限流记录会按上述期限过期。已经公开的 GitHub Issue 和图片受 GitHub 及图片托管规则约束，即使申请删除，也可能继续存在于缓存、Fork、通知或归档中。运行日志和统计数据会根据当前托管与统计配置，在安全、防滥用和维护所需范围内保留。",
    ],
    securityTitle: "安全措施与限制",
    securityParagraphs: [
      "DBX 会在适用场景使用敏感信息加密存储、签名软件包、受支持插件路径的沙箱隔离和网站会话认证等措施，但任何系统都无法保证绝对安全。",
      "请保护设备和数据目录、限制网络暴露、使用高强度的 DBX 与数据库凭据、及时更新 DBX 及其依赖、核对第三方服务地址，并妥善保护导出或同步的数据。如果你为其他人运营 DBX，还应负责适当的访问控制、隐私告知和合规要求。",
    ],
    changesTitle: "政策变更与联系方式",
    changesParagraphs: [
      "当 DBX 功能、网站服务或法律要求发生变化时，我们可能更新本政策。页面顶部的生效日期用于标识当前版本；重要变更会尽量在项目网站或发布材料中说明。",
      "如有隐私或安全问题，可通过 GitHub 支持渠道联系 DBX 维护者。不要在公开 Issue 中填写敏感信息；如果请求本身包含机密内容，请先要求提供合适的私下联系方式。",
    ],
    contactLabel: "打开 DBX 支持渠道",
    closing: "本政策说明的是官方 DBX 项目。第三方发行者或组织提供的 DBX 服务，可能另有同时适用的条款。",
  },
} as const;

function Paragraphs({ items }: { items: readonly string[] }) {
  return (
    <div className="grid gap-4 text-[15px] leading-7 text-landing-muted">
      {items.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
    </div>
  );
}

function PolicySection({ id, number, title, children }: { id: string; number: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-landing-line py-10 first:border-t-0 first:pt-0">
      <div className="mb-5 flex items-start gap-4">
        <span className="mt-0.5 inline-flex h-7 min-w-7 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--color-landing-sky)_32%,transparent)] bg-[color-mix(in_srgb,var(--color-landing-sky)_8%,transparent)] px-2 text-[11px] font-[750] tracking-[0.08em] text-landing-sky">
          {number}
        </span>
        <h2 className="text-[clamp(1.25rem,2.4vw,1.6rem)] font-[760] tracking-[-0.025em] text-landing-ink">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const locale = resolveLang(lang);
  const t = copy[locale];

  return buildMetadata({
    title: t.metadataTitle,
    description: t.metadataDescription,
    path: `/${locale}/privacy`,
    lang: locale,
  });
}

export default async function PrivacyPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const locale = resolveLang(lang);
  const t = copy[locale];

  return (
    <main className="min-h-screen bg-landing-bg text-landing-ink">
      <LandingNav lang={locale} active="privacy" />

      <div className="mx-auto max-w-[1180px] px-7 pb-24 pt-32 max-[760px]:px-[18px] max-[760px]:pb-16 max-[760px]:pt-24">
        <header className="max-w-[900px]">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-landing-line bg-landing-soft px-3 py-1.5 text-[11px] font-[720] uppercase tracking-[0.16em] text-landing-sky">
            <ShieldCheck size={14} aria-hidden="true" />
            {t.eyebrow}
          </div>
          <h1 className="max-w-[760px] text-[clamp(2.6rem,7vw,5.4rem)] font-[840] leading-[0.94] tracking-[-0.065em] text-landing-ink">{t.title}</h1>
          <p className="mt-7 max-w-[780px] text-[clamp(1.05rem,2.2vw,1.3rem)] leading-[1.7] text-landing-muted">{t.lead}</p>
          <dl className="mt-8 flex flex-wrap gap-x-8 gap-y-3 border-l-2 border-[color-mix(in_srgb,var(--color-landing-sky)_62%,transparent)] pl-5 text-sm">
            <div className="flex gap-2">
              <dt className="text-landing-muted">{t.effectiveLabel}</dt>
              <dd className="font-[650] text-landing-ink">{t.effectiveDate}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-landing-muted">{t.updatedLabel}</dt>
              <dd className="font-[650] text-landing-ink">{t.updatedDate}</dd>
            </div>
          </dl>
        </header>

        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {t.highlights.map((item, index) => {
            const Icon = [Database, Network, Globe2][index];
            return (
              <div key={item.title} className="rounded-2xl border border-landing-line bg-landing-panel p-6">
                <Icon size={20} aria-hidden="true" className="text-landing-sky" />
                <h2 className="mt-5 text-[15px] font-[720] text-landing-ink">{item.title}</h2>
                <p className="mt-2 text-[13px] leading-6 text-landing-muted">{item.description}</p>
              </div>
            );
          })}
        </div>

        <div className="mt-20 grid grid-cols-[220px_minmax(0,1fr)] items-start gap-14 max-[900px]:grid-cols-1 max-[900px]:gap-10 max-[900px]:mt-14">
          <aside className="sticky top-24 rounded-2xl border border-landing-line bg-landing-panel p-5 max-[900px]:static">
            <p className="text-[11px] font-[720] uppercase tracking-[0.14em] text-landing-muted">{t.contentsLabel}</p>
            <nav aria-label={t.contentsLabel} className="mt-3 grid gap-0.5 max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
              {t.sections.map(([id, label], index) => (
                <a key={id} href={`#${id}`} className="flex min-h-10 items-center gap-3 rounded-lg px-2 text-[13px] text-landing-muted transition-colors hover:bg-landing-soft hover:text-landing-ink">
                  <span className="font-mono text-[10px] text-landing-sky">{String(index + 1).padStart(2, "0")}</span>
                  <span>{label}</span>
                </a>
              ))}
            </nav>
          </aside>

          <div className="min-w-0 max-w-[780px]">
            <PolicySection id="scope" number="01" title={t.scopeTitle}>
              <Paragraphs items={t.scopeParagraphs} />
            </PolicySection>

            <PolicySection id="application-data" number="02" title={t.applicationTitle}>
              <p className="text-[15px] leading-7 text-landing-muted">{t.applicationIntro}</p>
              <ul className="mt-5 grid gap-3 text-[15px] leading-7 text-landing-muted">
                {t.applicationBullets.map((item) => (
                  <li key={item} className="flex gap-3">
                    <span aria-hidden="true" className="mt-[11px] size-1.5 shrink-0 rounded-full bg-landing-sky" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-5 text-[15px] leading-7 text-landing-muted">{t.applicationClosing}</p>
            </PolicySection>

            <PolicySection id="network" number="03" title={t.networkTitle}>
              <p className="text-[15px] leading-7 text-landing-muted">{t.networkIntro}</p>
              <div className="mt-6 overflow-hidden rounded-2xl border border-landing-line">
                <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-5 border-b border-landing-line bg-landing-soft px-5 py-3 text-[11px] font-[720] uppercase tracking-[0.12em] text-landing-muted max-[620px]:hidden">
                  <span>{t.networkColumns[0]}</span>
                  <span>{t.networkColumns[1]}</span>
                </div>
                {t.networkRows.map(([feature, description]) => (
                  <div key={feature} className="grid grid-cols-[180px_minmax(0,1fr)] gap-5 border-b border-landing-line px-5 py-5 last:border-b-0 max-[620px]:grid-cols-1 max-[620px]:gap-2">
                    <strong className="text-[14px] font-[680] text-landing-ink">{feature}</strong>
                    <p className="text-[14px] leading-6 text-landing-muted">{description}</p>
                  </div>
                ))}
              </div>
              <p className="mt-5 text-[15px] leading-7 text-landing-muted">{t.networkClosing}</p>
            </PolicySection>

            <PolicySection id="website" number="04" title={t.websiteTitle}>
              <div className="grid gap-4">
                {t.websiteItems.map((item) => (
                  <div key={item.title} className="rounded-xl border border-landing-line bg-landing-panel px-5 py-5">
                    <h3 className="text-[14px] font-[700] text-landing-ink">{item.title}</h3>
                    <p className="mt-2 text-[14px] leading-6 text-landing-muted">{item.description}</p>
                  </div>
                ))}
              </div>
            </PolicySection>

            <PolicySection id="retention" number="05" title={t.retentionTitle}>
              <Paragraphs items={t.retentionParagraphs} />
            </PolicySection>

            <PolicySection id="security" number="06" title={t.securityTitle}>
              <Paragraphs items={t.securityParagraphs} />
            </PolicySection>

            <PolicySection id="changes" number="07" title={t.changesTitle}>
              <Paragraphs items={t.changesParagraphs} />
              <Link href="https://github.com/t8y2/dbx/issues/new/choose" target="_blank" rel="noopener noreferrer" className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-lg border border-landing-line bg-landing-panel px-4 text-[13px] font-[680] text-landing-ink transition-colors hover:border-[color-mix(in_srgb,var(--color-landing-blue)_62%,transparent)]">
                {t.contactLabel}
                <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
              <p className="mt-8 border-l border-landing-line pl-5 text-[13px] leading-6 text-landing-muted">{t.closing}</p>
            </PolicySection>
          </div>
        </div>
      </div>

      <LandingFooter lang={locale} />
    </main>
  );
}
