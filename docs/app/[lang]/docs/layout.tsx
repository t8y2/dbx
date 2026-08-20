import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsSidebarFooter, DocsSidebarLanguageButton } from "@/components/DocsSidebarFooter";
import { StaticSearchDialog } from "@/components/StaticSearchDialog";
import { i18nUI } from "@/lib/i18n";
import { source } from "@/lib/source";

export default async function Layout({ params, children }: { params: Promise<{ lang: string }>; children: ReactNode }) {
  const { lang } = await params;
  const locale = lang === "cn" ? "cn" : "en";

  return (
    <RootProvider
      i18n={i18nUI.provider(locale)}
      search={{
        SearchDialog: StaticSearchDialog,
      }}
      theme={{ defaultTheme: "system", enableSystem: true }}
    >
      <DocsLayout
        tree={source.getPageTree(locale)}
        nav={{
          title: (
            <div className="flex items-center gap-2">
              <img src="/logo-64.png" alt="" aria-hidden="true" width={24} height={24} />
              <span className="font-semibold">DBX</span>
            </div>
          ),
          children: <DocsSidebarLanguageButton />,
        }}
        i18n={false}
        themeSwitch={{ enabled: false }}
        sidebar={{
          defaultOpenLevel: 1,
          footer: <DocsSidebarFooter key="docs-sidebar-footer" />,
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
