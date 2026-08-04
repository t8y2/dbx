"use client";

import type { FormEvent } from "react";
import { Send } from "lucide-react";

const CONTACT_EMAIL = "1156263951@qq.com";

const i18n = {
  en: {
    nameLabel: "Name",
    namePlaceholder: "How should we address you?",
    emailLabel: "Email",
    emailPlaceholder: "you@company.com",
    organizationLabel: "Organization",
    optional: "optional",
    organizationPlaceholder: "Company, team, or community",
    supportTypeLabel: "Support type",
    supportTypes: ["Financial sponsorship", "Infrastructure or services", "Developer tools", "Community collaboration", "Other"],
    messageLabel: "How would you like to support DBX?",
    messagePlaceholder: "Share your idea, available resources, expected timeline, and anything else that helps us understand the proposal.",
    submit: "Continue in email",
    privacy: "This opens your email app with the message prepared. DBX does not store the form content on this website.",
    alternatives: "Other ways to reach us",
    qq: "QQ: 86554840",
    subject: "DBX sponsorship inquiry",
    emailBody: {
      greeting: "Hello DBX team,",
      name: "Name",
      email: "Email",
      organization: "Organization",
      supportType: "Support type",
      message: "Message",
      source: "Source page",
    },
  },
  cn: {
    nameLabel: "姓名",
    namePlaceholder: "怎么称呼你？",
    emailLabel: "电子邮箱",
    emailPlaceholder: "you@company.com",
    organizationLabel: "公司或团队",
    optional: "选填",
    organizationPlaceholder: "公司、团队或社区名称",
    supportTypeLabel: "支持方式",
    supportTypes: ["资金赞助", "基础设施或服务资源", "开发工具", "社区合作", "其他"],
    messageLabel: "你希望如何支持 DBX？",
    messagePlaceholder: "可以介绍合作想法、可提供的资源、预期时间，以及其他便于我们了解方案的信息。",
    submit: "用邮箱发送",
    privacy: "点击后会打开你的邮件客户端并预填内容，DBX 不会在本站保存这些表单信息。",
    alternatives: "其他联系方式",
    qq: "QQ：86554840",
    subject: "DBX 赞助合作咨询",
    emailBody: {
      greeting: "你好，DBX 团队：",
      name: "姓名",
      email: "电子邮箱",
      organization: "公司或团队",
      supportType: "支持方式",
      message: "合作说明",
      source: "来源页面",
    },
  },
};

export function SponsorContactForm({ lang }: { lang: "en" | "cn" }) {
  const t = i18n[lang];

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const value = (field: string) => String(formData.get(field) ?? "").trim();
    const body = [
      t.emailBody.greeting,
      "",
      `${t.emailBody.name}: ${value("name")}`,
      `${t.emailBody.email}: ${value("email")}`,
      `${t.emailBody.organization}: ${value("organization") || "-"}`,
      `${t.emailBody.supportType}: ${value("supportType")}`,
      "",
      `${t.emailBody.message}:`,
      value("message"),
      "",
      `${t.emailBody.source}: ${window.location.href}`,
    ].join("\n");

    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(t.subject)}&body=${encodeURIComponent(body)}`;
  }

  const fieldClassName =
    "mt-2 min-h-11 w-full rounded-lg border border-landing-line bg-[#0d1422] px-3.5 text-sm text-landing-ink outline-none transition placeholder:text-[#65758b] focus:border-[#6ea8ff]/70 focus:ring-2 focus:ring-[#6ea8ff]/15";

  return (
    <form onSubmit={handleSubmit} className="grid gap-5" aria-label={t.subject}>
      <div className="grid grid-cols-2 gap-4 max-[640px]:grid-cols-1">
        <label className="text-sm font-[650] text-landing-ink">
          {t.nameLabel}
          <input className={fieldClassName} name="name" type="text" autoComplete="name" placeholder={t.namePlaceholder} required />
        </label>
        <label className="text-sm font-[650] text-landing-ink">
          {t.emailLabel}
          <input className={fieldClassName} name="email" type="email" autoComplete="email" placeholder={t.emailPlaceholder} required />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-4 max-[640px]:grid-cols-1">
        <label className="text-sm font-[650] text-landing-ink">
          {t.organizationLabel} <span className="font-normal text-landing-muted">({t.optional})</span>
          <input className={fieldClassName} name="organization" type="text" autoComplete="organization" placeholder={t.organizationPlaceholder} />
        </label>
        <label className="text-sm font-[650] text-landing-ink">
          {t.supportTypeLabel}
          <select className={fieldClassName} name="supportType" defaultValue={t.supportTypes[0]} required>
            {t.supportTypes.map((supportType) => (
              <option key={supportType} value={supportType}>
                {supportType}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="text-sm font-[650] text-landing-ink">
        {t.messageLabel}
        <textarea className={`${fieldClassName} min-h-32 resize-y py-3 leading-relaxed`} name="message" placeholder={t.messagePlaceholder} required />
      </label>

      <div className="flex items-center justify-between gap-5 max-[640px]:items-stretch max-[640px]:flex-col">
        <p className="max-w-[440px] text-xs leading-relaxed text-landing-muted">{t.privacy}</p>
        <button
          type="submit"
          className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#f2f7ff] px-5 text-sm font-[720] text-[#0b1120] transition hover:-translate-y-0.5 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-landing-sky"
        >
          <Send aria-hidden="true" size={16} strokeWidth={2.2} />
          {t.submit}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-landing-line pt-4 text-xs text-landing-muted">
        <span>{t.alternatives}</span>
        <span>{t.qq}</span>
      </div>
    </form>
  );
}
