import { source } from "@/lib/source";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from "fumadocs-ui/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Callout } from "fumadocs-ui/components/callout";
import { Card, Cards } from "fumadocs-ui/components/card";
import { ImageZoom } from "fumadocs-ui/components/image-zoom";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import type { MDXContent } from "mdx/types";
import type { TOCItemType } from "fumadocs-core/toc";
import { buildMetadata, SITE_URL } from "@/lib/metadata";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug?: string[] }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  const page = source.getPage(slug, lang);
  if (!page) return {};

  const title = page.data.title as string;
  const description = (page.data.description as string) || undefined;

  return buildMetadata({
    title,
    description: description ?? "",
    path: slug ? `/${lang}/docs/${slug.join("/")}` : `/${lang}/docs`,
    lang,
    ogType: "article",
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
  const docPath = slug ? `/${lang}/docs/${slug.join("/")}` : `/${lang}/docs`;

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "Docs", item: `${SITE_URL}/${lang}/docs` },
      ...(slug
        ? slug.map((segment, i) => ({
            "@type": "ListItem" as const,
            position: i + 3,
            name: segment.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
            item: `${SITE_URL}/${lang}/docs/${slug.slice(0, i + 1).join("/")}`,
          }))
        : []),
    ],
  };

  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: title,
    description,
    inLanguage: lang === "cn" ? "zh-CN" : "en",
    isPartOf: {
      "@type": "WebSite",
      url: SITE_URL,
    },
  };

  return (
    <DocsPage toc={toc}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }} />
      <DocsTitle>{title}</DocsTitle>
      <DocsDescription>{description}</DocsDescription>
      <DocsBody>
        <MDX components={mdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams().map((params) => ({
    lang: params.lang,
    slug: params.slug,
  }));
}
