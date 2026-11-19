import { source } from "@/lib/source";
import { llmsIndex } from "@/lib/llms";

export const dynamic = "force-static";

export function GET() {
  return new Response(llmsIndex(source.getPages()), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
