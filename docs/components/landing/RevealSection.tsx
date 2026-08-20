import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";

type RevealSectionProps = Omit<ComponentPropsWithoutRef<"section">, "children" | "className"> & {
  children: ReactNode;
  className?: string;
  delay?: number;
};

export function RevealSection({ children, className = "", delay = 0, ...sectionProps }: RevealSectionProps) {
  return (
    <section {...sectionProps} className={`${className} landing-reveal is-visible`} style={{ ...sectionProps.style, "--reveal-delay": `${delay}ms` } as CSSProperties}>
      {children}
    </section>
  );
}
