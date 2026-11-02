import { source } from "@/lib/source";
import { documentMarkdown } from "@/lib/llms";

export const dynamic = "force-static";

export async function GET() {
  const pages = [...source.getPages()].sort((left, right) => left.url.localeCompare(right.url, "en"));
  const documents = await Promise.all(pages.map(documentMarkdown));
  return new Response(documents.join("\n---\n\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
