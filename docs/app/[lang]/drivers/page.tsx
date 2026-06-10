import { DriversClient } from "./DriversClient";
import { buildMetadata } from "@/lib/metadata";
import type { Metadata } from "next";

const pageMeta = {
  en: {
    title: "Offline Driver Downloads",
    description: "Download all database drivers and JRE packages for offline use. Supports 30+ database types across macOS, Linux, and Windows.",
  },
  cn: {
    title: "离线驱动下载",
    description: "下载所有数据库驱动和 JRE 离线包，支持 30+ 种数据库类型，覆盖 macOS、Linux、Windows 平台。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = lang === "cn" ? "cn" : "en";
  const meta = pageMeta[l];

  return buildMetadata({
    title: meta.title,
    description: meta.description,
    path: `/${l}/drivers`,
    lang: l,
    ogType: "website",
  });
}

export default function DriversPage() {
  return <DriversClient />;
}
