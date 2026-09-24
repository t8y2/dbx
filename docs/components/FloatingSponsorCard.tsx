"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";

const DISMISS_STORAGE_KEY = "dbx.docs.sponsorCard.dismissedAt";
// 关闭 7 天后重新出现
const RESURFACE_MS = 7 * 24 * 60 * 60 * 1000;

const RAINYUN_URL = "https://www.rainyun.com/MTE5Mjc4Ng==_";

const COPY = {
  cn: {
    badge: "赞助商",
    tagline: "云服务器 · 游戏云 · 物理服务器",
    closeLabel: "关闭赞助卡片",
  },
  en: {
    badge: "Sponsor",
    tagline: "Cloud servers, game hosting & bare metal",
    closeLabel: "Dismiss sponsor card",
  },
} as const;

export function FloatingSponsorCard({ lang }: { lang: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const dismissedAt = Number(window.localStorage.getItem(DISMISS_STORAGE_KEY));
      if (!Number.isFinite(dismissedAt) || Date.now() - dismissedAt > RESURFACE_MS) {
        setVisible(true);
      }
    } catch {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
    } catch {
      // localStorage 不可用时按本次会话关闭处理
    }
  };

  const t = lang === "cn" ? COPY.cn : COPY.en;

  return (
    <aside
      aria-label={t.badge}
      className="sponsor-card-in fixed bottom-4 right-4 z-30 w-52 rounded-xl border border-fd-border bg-fd-card/95 p-2.5 shadow-lg backdrop-blur"
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium tracking-wide text-fd-muted-foreground">{t.badge}</span>
        <button
          type="button"
          aria-label={t.closeLabel}
          onClick={dismiss}
          className="rounded-md p-1 text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <a href={RAINYUN_URL} target="_blank" rel="nofollow sponsored noopener noreferrer" className="group mt-1.5 block">
        {/* 品牌图为白底，暗色主题下需显式白底容器承载 */}
        <span className="block overflow-hidden rounded-lg bg-white ring-1 ring-black/5 transition-shadow group-hover:ring-black/15">
          <img src="/sponsors/rainyun-card.png" alt="RainYun" width={400} height={160} className="h-auto w-full" />
        </span>
        <span className="mt-1 block text-center text-xs text-fd-muted-foreground">{t.tagline}</span>
      </a>
    </aside>
  );
}
