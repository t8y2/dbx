"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

type RevealSectionProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
};

export function RevealSection({ children, className = "", delay = 0 }: RevealSectionProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -14% 0px", threshold: 0.18 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={ref} className={`${className} landing-reveal${visible ? " is-visible" : ""}`} style={{ "--reveal-delay": `${delay}ms` } as CSSProperties}>
      {children}
    </section>
  );
}
