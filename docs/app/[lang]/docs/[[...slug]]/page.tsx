import { source } from "@/lib/source";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { DocsPage, DocsBody, DocsTitle } from "fumadocs-ui/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Callout } from "fumadocs-ui/components/callout";
import { Card, Cards } from "fumadocs-ui/components/card";
import { ImageZoom } from "fumadocs-ui/components/image-zoom";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import type { MDXContent } from "mdx/types";
import type { TOCItemType } from "fumadocs-core/toc";
import { buildMetadata } from "@/lib/metadata";
import { resolveLang } from "@/lib/i18n";
import { markdownPath } from "@/lib/llms";
import { buildDocStructuredData, serializeStructuredData } from "@/lib/structuredData";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug?: string[] }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  const page = source.getPage(slug, lang);
  if (!page) return {};

  const title = page.data.title as string;
  const description = (page.data.description as string) || undefined;

  return buildMetadata({
    title: `${title} · ${lang === "cn" ? "使用文档" : "Documentation"}`,
    description: description ?? "",
    path: slug?.length ? `/${lang}/docs/${slug.join("/")}` : `/${lang}/docs`,
    lang,
    ogType: "article",
    markdownPath: markdownPath(slug?.length ? `/${lang}/docs/${slug.join("/")}` : `/${lang}/docs`),
  });
}

const mdxComponents = {
  ...defaultMdxComponents,
  Tab,
  Tabs,
  Step,
  Steps,
  Callout,
  Card,
  Cards,
  ImageZoom,
  Accordion,
  Accordions,
};

export default async function Page({ params }: { params: Promise<{ lang: string; slug?: string[] }> }) {
  const { lang, slug } = await params;
  const page = source.getPage(slug, lang);
  if (!page) notFound();

  const { body: MDX, toc } = page.data as unknown as {
    body: MDXContent;
    toc: TOCItemType[];
  };

  const title = page.data.title as string;
  const description = (page.data.description as string) || "";
  const docPath = slug?.length ? `/${lang}/docs/${slug.join("/")}` : `/${lang}/docs`;
  const structuredData = buildDocStructuredData(resolveLang(lang), title, description, docPath);

  return (
    <main className="contents">
      <DocsPage toc={toc}>
        {structuredData.map((entry) => (
          <script key={entry["@id"]} type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeStructuredData(entry) }} />
        ))}
        <DocsTitle>{title}</DocsTitle>
        <DocsBody>
          <MDX components={mdxComponents} />
        </DocsBody>
      </DocsPage>
    </main>
  );
}

export function generateStaticParams() {
  return source.generateParams().map((params) => ({
    lang: params.lang,
    slug: params.slug,
  }));
}
