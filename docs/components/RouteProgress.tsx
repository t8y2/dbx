"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

type ProgressApi = { start: () => void; done: () => void };

// nprogress 风格的路由跳转进度条：捕获站内链接点击或前进/后退时开始，
// App Router 的 pathname 变化（导航完成）时冲到 100% 并淡出。
// 全程命令式操作 DOM，不触发 React 渲染。
export function RouteProgress() {
  const pathname = usePathname();
  const barRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<ProgressApi | null>(null);
  const isFirstRoute = useRef(true);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    let shown = false;
    let progress = 0;
    let trickleTimer = 0;
    let hideTimer = 0;

    const render = () => {
      bar.style.transform = `scaleX(${progress})`;
      bar.style.opacity = shown ? "1" : "0";
    };

    const start = () => {
      if (shown) return;
      shown = true;
      progress = 0.08;
      render();
      window.clearInterval(trickleTimer);
      trickleTimer = window.setInterval(() => {
        // 越接近 90% 走得越慢，nprogress 的经典节奏
        progress += (0.9 - progress) * 0.14;
        render();
      }, 120);
      // 导航异常（目标不可达等）时兜底收尾，避免进度条卡在 90%
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(done, 6000);
    };

    const done = () => {
      if (!shown) return;
      window.clearInterval(trickleTimer);
      window.clearTimeout(hideTimer);
      progress = 1;
      render();
      hideTimer = window.setTimeout(() => {
        shown = false;
        render();
        window.setTimeout(() => {
          progress = 0;
          bar.style.transform = "scaleX(0)";
        }, 240);
      }, 200);
    };

    apiRef.current = { start, done };

    const isInternalNavigation = (href: string) => {
      try {
        const url = new URL(href, window.location.origin);
        return url.origin === window.location.origin && (url.pathname !== window.location.pathname || url.search !== window.location.search);
      } catch {
        return false;
      }
    };

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      // 只处理站内路径跳转；纯 hash 锚点和外链不触发
      if (!href || !href.startsWith("/") || href.startsWith("//")) return;
      if (!isInternalNavigation(href)) return;
      start();
    };

    const onPopState = () => start();

    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
      window.clearInterval(trickleTimer);
      window.clearTimeout(hideTimer);
    };
  }, []);

  useEffect(() => {
    if (isFirstRoute.current) {
      isFirstRoute.current = false;
      return;
    }
    apiRef.current?.done();
  }, [pathname]);

  return <div ref={barRef} className="route-progress-bar" aria-hidden="true" />;
}
