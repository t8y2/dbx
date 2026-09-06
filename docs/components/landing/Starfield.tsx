"use client";

import { useEffect, useRef } from "react";

type StarfieldProps = {
  className?: string;
};

type StarSprite = {
  canvas: HTMLCanvasElement;
  size: number;
};

type Star = {
  alpha: number;
  color: string;
  glow: number;
  phase: number;
  radius: number;
  scrollFactor: number;
  speed: number;
  sprite?: StarSprite;
  twinkleSpeed: number;
  x: number;
  y: number;
};

const STAR_COLORS = ["255,255,255", "197,225,255", "139,213,255", "255,218,198"] as const;
const DIM_RADII = [0.55, 0.75, 0.95, 1.2] as const;
const BRIGHT_RADII = [1.45, 1.8, 2.15, 2.5] as const;
const BRIGHT_GLOWS = [5, 7, 9, 11] as const;

function createRandom(seed: number) {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function createStars(width: number, height: number) {
  const random = createRandom(0x51a2f17d);
  const count = Math.min(1100, Math.max(260, Math.round(width * height * 0.0009)));

  return Array.from({ length: count }, (): Star => {
    const depth = random();
    const bright = random() > 0.94;
    const styleIndex = Math.floor(random() * 4);
    const speed = 0.8 + depth * 2.7;

    return {
      x: random() * width,
      y: random() * height,
      radius: bright ? BRIGHT_RADII[styleIndex] : DIM_RADII[styleIndex],
      alpha: bright ? 0.68 + random() * 0.26 : 0.24 + depth * 0.48,
      color: STAR_COLORS[Math.floor(random() * STAR_COLORS.length)],
      glow: bright ? BRIGHT_GLOWS[styleIndex] : 0,
      phase: random() * Math.PI * 2,
      scrollFactor: 0.055 + speed * 0.018,
      speed,
      twinkleSpeed: 0.45 + random() * 1.25,
    };
  });
}

function createStarSprite(star: Star, pixelRatio: number): StarSprite {
  const size = Math.ceil((star.radius + star.glow) * 2 + 4);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(size * pixelRatio);
  canvas.height = Math.ceil(size * pixelRatio);

  const context = canvas.getContext("2d");
  if (!context) return { canvas, size };

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.beginPath();
  context.fillStyle = `rgb(${star.color})`;
  context.shadowBlur = star.glow;
  context.shadowColor = `rgba(${star.color},0.75)`;
  context.arc(size / 2, size / 2, star.radius, 0, Math.PI * 2);
  context.fill();

  return { canvas, size };
}

function starSpriteKey(star: Star) {
  return `${star.color}:${star.radius}:${star.glow}`;
}

export function Starfield({ className = "" }: StarfieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    const context = canvas?.getContext("2d");
    if (!canvas || !container || !context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sprites = new Map<string, StarSprite>();
    let animationFrame = 0;
    let stars: Star[] = [];
    let width = 0;
    let height = 0;
    let scrollOffset = window.scrollY;
    let startedAt = performance.now();

    const draw = (now: number) => {
      const elapsed = (now - startedAt) / 1000;
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = "screen";

      for (const star of stars) {
        const sprite = star.sprite;
        if (!sprite) continue;

        const x = (star.x + elapsed * star.speed) % width;
        const scrollParallax = scrollOffset * star.scrollFactor;
        const y = (star.y - elapsed * star.speed * 0.34 - scrollParallax + height * 2) % height;
        const pulse = reducedMotion.matches ? 0.9 : 0.72 + Math.sin(star.phase + elapsed * star.twinkleSpeed) * 0.28;

        context.globalAlpha = star.alpha * pulse;
        context.drawImage(sprite.canvas, x - sprite.size / 2, y - sprite.size / 2, sprite.size, sprite.size);
      }

      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
    };

    const animate = (now: number) => {
      draw(now);
      animationFrame = window.requestAnimationFrame(animate);
    };

    const start = () => {
      window.cancelAnimationFrame(animationFrame);
      startedAt = performance.now();
      if (reducedMotion.matches || document.hidden) {
        draw(startedAt);
        return;
      }
      animationFrame = window.requestAnimationFrame(animate);
    };

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.imageSmoothingEnabled = true;

      stars = createStars(width, height);
      sprites.clear();
      for (const star of stars) {
        const key = starSpriteKey(star);
        if (!sprites.has(key)) sprites.set(key, createStarSprite(star, pixelRatio));
        star.sprite = sprites.get(key);
      }
      start();
    };

    const handleVisibilityChange = () => start();
    const handleScroll = () => {
      scrollOffset = window.scrollY;
      if (reducedMotion.matches) draw(performance.now());
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    reducedMotion.addEventListener("change", start);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("scroll", handleScroll, { passive: true });
    resize();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      reducedMotion.removeEventListener("change", start);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  return (
    <div aria-hidden="true" className={`landing-starfield landing-starfield--page ${className}`.trim()}>
      <canvas ref={canvasRef} className="landing-starfield-canvas" />
    </div>
  );
}
