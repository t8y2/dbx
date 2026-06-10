import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsSidebarFooter, DocsSidebarLanguageButton } from "@/components/DocsSidebarFooter";
import { source } from "@/lib/source";

export default async function Layout({ params, children }: { params: Promise<{ lang: string }>; children: ReactNode }) {
  const { lang } = await params;

  return (
    <DocsLayout
      tree={source.getPageTree(lang)}
      nav={{
        title: (
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="DBX" width={24} height={24} />
            <span className="font-semibold">DBX</span>
          </div>
        ),
        children: <DocsSidebarLanguageButton />,
      }}
      i18n={false}
      themeSwitch={{ enabled: false }}
      sidebar={{
        defaultOpenLevel: 1,
        footer: <DocsSidebarFooter />,
      }}
    >
      {children}
    </DocsLayout>
  );
}
