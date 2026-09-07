import { DriversClient } from "./DriversClient";
import { fetchAgentDownloadCatalog } from "@/lib/agentRegistrySource";
import { buildMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import { resolveLang } from "@/lib/i18n";

const pageMeta = {
  en: {
    title: "Offline Driver Downloads",
    description: "Download DBX offline driver bundles, database drivers, and JRE packages for air-gapped environments across macOS, Linux, and Windows.",
  },
  tr: {
    title: "Çevrimdışı Sürücü İndirmeleri",
    description: "İnternet erişimi olmayan ortamlar için DBX çevrimdışı sürücü paketlerini, veritabanı sürücülerini ve JRE paketlerini macOS, Linux ve Windows için indirin.",
  },
  cn: {
    title: "离线驱动下载",
    description: "下载 DBX 离线驱动整包、数据库驱动和 JRE 离线包，覆盖 macOS、Linux、Windows 平台。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = resolveLang(lang);
  const meta = pageMeta[l];

  return buildMetadata({
    title: meta.title,
    description: meta.description,
    path: `/${l}/drivers`,
    lang: l,
    ogType: "website",
  });
}

export default async function DriversPage() {
  const catalog = await fetchAgentDownloadCatalog();
  if (!catalog) throw new Error("Unable to generate the static driver catalog from R2 or CNB");
  return <DriversClient initialCatalog={catalog} />;
}
