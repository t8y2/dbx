import { DriversClient } from "./DriversClient";
import { buildMetadata } from "@/lib/metadata";
import type { Metadata } from "next";

const pageMeta = {
  en: {
    title: "Offline Driver Downloads",
    description: "Download DBX offline driver bundles, database drivers, and JRE packages for air-gapped environments across macOS, Linux, and Windows.",
  },
  cn: {
    title: "离线驱动下载",
    description: "下载 DBX 离线驱动整包、数据库驱动和 JRE 离线包，覆盖 macOS、Linux、Windows 平台。",
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
