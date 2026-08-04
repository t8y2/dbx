"use client";

import type { ReactNode } from "react";
import { useState } from "react";

export function ExpandableDatabaseGrid({ children, lang }: { children: ReactNode; lang: "en" | "cn" }) {
  const [expanded, setExpanded] = useState(false);
  const label = expanded
    ? lang === "cn"
      ? "收起数据库列表"
      : "Show fewer databases"
    : lang === "cn"
      ? "展开全部数据库"
      : "Show all databases";

  return (
    <>
      <div
        id="landing-database-grid"
        className="landing-database-grid grid grid-cols-9 gap-3 max-[1240px]:grid-cols-7 max-[960px]:grid-cols-5 max-[640px]:grid-cols-4 max-[360px]:grid-cols-3 max-[760px]:gap-2"
        data-expanded={expanded}
      >
        {children}
      </div>
      <button
        type="button"
        className="landing-database-toggle mt-3 hidden min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-landing-line bg-landing-panel px-4 text-sm font-[650] text-landing-ink max-[760px]:flex"
        aria-controls="landing-database-grid"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span>{label}</span>
        <span aria-hidden="true">{expanded ? "−" : "+"}</span>
      </button>
    </>
  );
}
