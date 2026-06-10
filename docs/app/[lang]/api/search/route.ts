import { createFromSource } from "fumadocs-core/search/server";
import { createCjkSearchTokenizer } from "@/lib/cjkSearchTokenizer";
import { source } from "@/lib/source";

export const revalidate = false;
export const { staticGET: GET } = createFromSource(source, {
  localeMap: {
    cn: { components: { tokenizer: createCjkSearchTokenizer() } },
  },
});

export function generateStaticParams() {
  return [{ lang: "en" }, { lang: "cn" }];
}
