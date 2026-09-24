import { source } from "@/lib/source";
import { documentMarkdown } from "@/lib/llms";

export const dynamic = "force-static";

export async function GET(_request: Request, { params }: { params: Promise<{ lang: string; slug: string[] }> }) {
  const { lang, slug } = await params;
  const documentSlug = slug.join("/").replace(/\.md$/, "");
  const page = source.getPage(documentSlug === "index" ? [] : documentSlug.split("/"), lang);
  if (!page) return new Response("Not found", { status: 404 });
  return new Response(await documentMarkdown(page), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

export function generateStaticParams() {
  return source.generateParams().map(({ lang, slug }) => ({
    lang,
    slug: `${slug.length ? slug.join("/") : "index"}.md`.split("/"),
  }));
}
