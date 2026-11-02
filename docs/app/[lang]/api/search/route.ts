import { createFromSource } from "fumadocs-core/search/server";
import { createCjkSearchTokenizer } from "@/lib/cjkSearchTokenizer";
import { source } from "@/lib/source";
import { i18n } from "@/lib/i18n";

export const revalidate = false;
export const { staticGET: GET } = createFromSource(source, {
  localeMap: {
    cn: { components: { tokenizer: createCjkSearchTokenizer() } },
  },
});

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}
