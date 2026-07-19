"use client";

import { useEffect, useMemo, useState } from "react";
import { Award, Download, ExternalLink, Github, LogOut, Search, ShieldCheck } from "lucide-react";
import type { ContributorActivity, ContributorActivityData } from "@/lib/contributorActivity";
import styles from "./ContributorsExperience.module.css";

type Language = "en" | "cn";
type AuthUser = { login: string; avatarUrl: string; profileUrl: string };
type AuthState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; user: AuthUser };

const copy = {
  en: {
    title: "Your work is part of DBX.",
    intro: "Sign in with GitHub to verify your identity and collect a shareable certificate for pull requests merged into DBX.",
    signIn: "Verify with GitHub",
    signingIn: "Checking GitHub session…",
    contributors: "verified contributors",
    merged: "merged pull requests",
    commits: "repository commits",
    stars: "GitHub stars",
    directory: "Contributor directory",
    search: "Search GitHub login",
    noResults: "No matching contributor.",
    signedInAs: "Verified as",
    claim: "Open my certificate",
    notEligible: "This GitHub account does not have a merged pull request in DBX yet.",
    contributionCallout: "Ship a focused pull request and join the wall.",
    viewGuide: "Contribution guide",
    signOut: "Sign out",
    certificate: "Open-source contributor",
    awardedTo: "Presented to",
    certificateBody: "For work accepted and merged into DBX, helping make database tools better for everyone.",
    download: "Download certificate",
    close: "Close",
    mergedLabel: "MERGED PULL REQUESTS",
    verified: "GITHUB IDENTITY VERIFIED",
  },
  cn: {
    title: "你的代码，已经成为 DBX 的一部分。",
    intro: "使用 GitHub 验证身份，领取一张属于你的贡献者证书，记录被 DBX 接受并合并的 Pull Request。",
    signIn: "使用 GitHub 验证身份",
    signingIn: "正在检查 GitHub 登录状态…",
    contributors: "位贡献者",
    merged: "个已合并 PR",
    commits: "次仓库 Commit",
    stars: "个 GitHub Star",
    directory: "完整贡献者名单",
    search: "搜索 GitHub 用户名",
    noResults: "没有匹配的贡献者。",
    signedInAs: "已验证身份",
    claim: "打开我的证书",
    notEligible: "这个 GitHub 账号暂时还没有被 DBX 合并的 Pull Request。",
    contributionCallout: "提交一个专注、可合并的 PR，加入这面贡献者墙。",
    viewGuide: "查看贡献指南",
    signOut: "退出验证",
    certificate: "开源项目贡献者",
    awardedTo: "授予",
    certificateBody: "感谢你的代码被 DBX 接受并合并，让每个人都能使用更好的数据库工具。",
    download: "下载贡献者证书",
    close: "关闭",
    mergedLabel: "已合并 PULL REQUEST",
    verified: "GITHUB 身份已验证",
  },
} as const;

function formatNumber(value: number, lang: Language) {
  return new Intl.NumberFormat(lang === "cn" ? "zh-CN" : "en-US").format(value);
}

function initials(login: string) {
  return login.slice(0, 2).toUpperCase();
}

function loadImage(source: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

async function drawCertificate(contributor: ContributorActivity, lang: Language) {
  const canvas = document.createElement("canvas");
  canvas.width = 1800;
  canvas.height = 1120;
  const context = canvas.getContext("2d");
  if (!context) return;
  const text = copy[lang];
  const [logo, avatar] = await Promise.all([loadImage("/logo.png"), loadImage(`/api/contributor-avatar?login=${encodeURIComponent(contributor.login)}`)]);

  // The downloaded artifact is the certificate itself, not a screenshot of the page backdrop.
  context.fillStyle = "#fffdf8";
  context.fillRect(0, 0, 1800, 1120);

  context.fillStyle = "#fffdf8";
  context.beginPath();
  context.roundRect(92, 82, 1616, 956, 38);
  context.fill();
  context.strokeStyle = "#e2b94f";
  context.lineWidth = 4;
  context.strokeRect(126, 116, 1548, 888);
  context.strokeStyle = "rgba(226,185,79,0.38)";
  context.lineWidth = 1;
  context.strokeRect(144, 134, 1512, 852);

  if (logo) context.drawImage(logo, 196, 174, 58, 58);
  context.fillStyle = "#5b67d9";
  context.font = "800 32px ui-monospace, monospace";
  context.fillText("DBX · OPEN SOURCE DATABASE TOOL", 276, 216);
  context.fillStyle = "#a17c21";
  context.font = "700 22px ui-monospace, monospace";
  context.fillText(text.verified, 196, 260);

  context.fillStyle = "#242640";
  context.font = "800 70px sans-serif";
  context.fillText(text.certificate, 196, 410);
  context.fillStyle = "#79788a";
  context.font = "500 28px sans-serif";
  context.fillText(text.awardedTo, 196, 474);
  context.fillStyle = "#5b67d9";
  context.font = "800 104px sans-serif";
  context.fillText(`@${contributor.login}`, 196, 596);

  context.fillStyle = "#5e5e72";
  context.font = "400 29px sans-serif";
  context.fillText(text.certificateBody, 196, 672);

  const metrics = [
    [formatNumber(contributor.mergedPullRequests, lang), text.mergedLabel],
    [formatNumber(contributor.commits, lang), "COMMITS"],
  ];
  metrics.forEach(([value, label], index) => {
    const x = 196 + index * 500;
    context.fillStyle = "#f7f0d8";
    context.beginPath();
    context.roundRect(x, 746, 470, 142, 22);
    context.fill();
    context.fillStyle = "#242640";
    context.font = "800 58px ui-monospace, monospace";
    context.fillText(value, x + 34, 818);
    context.fillStyle = "#9a7a25";
    context.font = "700 18px ui-monospace, monospace";
    context.fillText(label, x + 34, 854);
  });

  context.fillStyle = "#e2b94f";
  context.beginPath();
  context.arc(1458, 540, 134, 0, Math.PI * 2);
  context.fill();
  context.save();
  context.beginPath();
  context.arc(1458, 540, 118, 0, Math.PI * 2);
  context.clip();
  if (avatar) {
    context.drawImage(avatar, 1340, 422, 236, 236);
  } else {
    context.fillStyle = "#fffdf6";
    context.fillRect(1340, 422, 236, 236);
    context.fillStyle = "#5b67d9";
    context.font = "800 60px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText(initials(contributor.login), 1458, 560);
    context.textAlign = "left";
  }
  context.restore();

  context.fillStyle = "#8b8998";
  context.font = "500 19px ui-monospace, monospace";
  context.fillText(`t8y2/dbx · ${new Date().toISOString().slice(0, 10)}`, 196, 948);

  const link = document.createElement("a");
  link.download = `dbx-contributor-${contributor.login}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function GithubMark() {
  return <Github size={19} strokeWidth={2.2} />;
}

export function ContributorsExperience({ data, lang }: { data: ContributorActivityData; lang: Language }) {
  const text = copy[lang];
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [certificateOpen, setCertificateOpen] = useState(false);

  const mergedPullRequests = useMemo(() => data.contributors.reduce((total, contributor) => total + contributor.mergedPullRequests, 0), [data.contributors]);
  const commits = useMemo(() => data.contributors.reduce((total, contributor) => total + contributor.commits, 0), [data.contributors]);
  const verifiedContributor = useMemo(() => {
    if (auth.status !== "signed-in") return null;
    return data.contributors.find((contributor) => contributor.login.toLowerCase() === auth.user.login.toLowerCase()) ?? null;
  }, [auth, data.contributors]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return data.contributors;
    return data.contributors.filter((contributor) => contributor.login.toLowerCase().includes(normalized));
  }, [data.contributors, query]);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((result: { authenticated?: boolean; user?: AuthUser } | null) => {
        if (result?.authenticated && result.user) setAuth({ status: "signed-in", user: result.user });
        else setAuth({ status: "signed-out" });
      })
      .catch(() => setAuth({ status: "signed-out" }));
  }, []);

  function signIn() {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/api/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`);
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
    setAuth({ status: "signed-out" });
    setCertificateOpen(false);
  }

  return (
    <div className={styles.experience}>
      <section className={styles.hero}>
        <div className={styles.sparkles} aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ "--i": index } as React.CSSProperties} />)}</div>
        <div className={styles.heroCopy}>
          <h1>{text.title}</h1>
          <p>{text.intro}</p>

          {auth.status === "loading" ? (
            <div className={styles.authLoading}>{text.signingIn}</div>
          ) : auth.status === "signed-out" ? (
            <button type="button" className={styles.githubButton} onClick={signIn}><GithubMark /> {text.signIn}</button>
          ) : (
            <div className={styles.verifiedPanel}>
              <img src={auth.user.avatarUrl} alt="" width={48} height={48} />
              <div><small>{text.signedInAs}</small><strong>@{auth.user.login}</strong></div>
              {verifiedContributor ? (
                <button type="button" onClick={() => setCertificateOpen(true)}><Award size={17} /> {text.claim}</button>
              ) : (
                <a href={`/${lang}/docs/contributing`}>{text.viewGuide}<ExternalLink size={14} /></a>
              )}
              <button type="button" className={styles.logoutButton} onClick={signOut} aria-label={text.signOut}><LogOut size={16} /></button>
            </div>
          )}
          {auth.status === "signed-in" && !verifiedContributor ? <p className={styles.notEligible}>{text.notEligible}<br />{text.contributionCallout}</p> : null}
        </div>

        <div className={styles.heroCertificate}>
          <div className={styles.certificatePreview}>
            <div className={styles.previewTop}><span><img src="/logo.png" alt="DBX" width={28} height={28} />DBX</span><ShieldCheck size={18} /></div>
            <small>{text.certificate}</small>
            <strong>@{verifiedContributor?.login ?? "YOUR_NAME"}</strong>
            <p>{text.certificateBody}</p>
            <div className={styles.previewMetrics}>
              <div><b>{verifiedContributor?.mergedPullRequests ?? "—"}</b><span>{text.mergedLabel}</span></div>
              <div><b>{verifiedContributor?.commits ?? "—"}</b><span>COMMITS</span></div>
            </div>
            <div className={styles.previewSeal}>{verifiedContributor ? <img src={verifiedContributor.avatarUrl} alt={verifiedContributor.login} width={92} height={92} /> : <Award size={32} />}</div>
          </div>
        </div>
      </section>

      <section className={styles.metrics}>
        <div><strong>{formatNumber(data.contributors.length, lang)}</strong><span>{text.contributors}</span></div>
        <div><strong>{formatNumber(mergedPullRequests, lang)}</strong><span>{text.merged}</span></div>
        <div><strong>{formatNumber(commits, lang)}</strong><span>{text.commits}</span></div>
        <div><strong>{formatNumber(data.stars, lang)}</strong><span>{text.stars}</span></div>
      </section>

      <section className={styles.directorySection}>
        <div className={styles.directoryHeader}><div><h2>{text.directory}</h2></div><label><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.search} /></label></div>
        {filtered.length ? (
          <div className={styles.directoryGrid}>
            {filtered.map((contributor) => (
              <a key={contributor.login} href={contributor.profileUrl} target="_blank" rel="noopener noreferrer">
                <img src={contributor.avatarUrl} alt="" width={46} height={46} loading="lazy" />
                <span><strong>@{contributor.login}</strong><small>{contributor.mergedPullRequests} {text.merged} · {contributor.commits} Commit</small></span>
                <ExternalLink size={15} />
              </a>
            ))}
          </div>
        ) : <div className={styles.empty}>{text.noResults}</div>}
      </section>

      {certificateOpen && verifiedContributor ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCertificateOpen(false); }}>
          <section className={styles.modal} role="dialog" aria-modal="true" aria-label={text.certificate}>
            <div className={styles.fullCertificate}>
              <div className={styles.previewTop}><span><img src="/logo.png" alt="DBX" width={30} height={30} />DBX · OPEN SOURCE DATABASE TOOL</span><ShieldCheck size={20} /></div>
              <span className={styles.verifiedText}>{text.verified}</span>
              <small>{text.certificate}</small>
              <em>{text.awardedTo}</em>
              <h2>@{verifiedContributor.login}</h2>
              <p>{text.certificateBody}</p>
              <div className={styles.fullMetrics}>
                <div><b>{verifiedContributor.mergedPullRequests}</b><span>{text.mergedLabel}</span></div>
                <div><b>{verifiedContributor.commits}</b><span>COMMITS</span></div>
              </div>
              <div className={styles.fullSeal}><img src={verifiedContributor.avatarUrl} alt={verifiedContributor.login} width={128} height={128} /></div>
              <footer><span>t8y2/dbx</span><span>dbxio.com</span></footer>
            </div>
            <div className={styles.modalActions}>
              <button type="button" onClick={() => drawCertificate(verifiedContributor, lang)}><Download size={17} /> {text.download}</button>
              <button type="button" onClick={() => setCertificateOpen(false)}>{text.close}</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
