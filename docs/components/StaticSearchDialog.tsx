"use client";

import { create } from "@orama/orama";
import { useDocsSearch } from "fumadocs-core/search/client";
import { SearchDialog, SearchDialogClose, SearchDialogContent, SearchDialogFooter, SearchDialogHeader, SearchDialogIcon, SearchDialogInput, SearchDialogList, SearchDialogOverlay } from "fumadocs-ui/components/dialog/search";
import type { SharedProps } from "fumadocs-ui/contexts/search";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { useMemo, useState } from "react";
import { createCjkSearchTokenizer } from "@/lib/cjkSearchTokenizer";

export function StaticSearchDialog(props: SharedProps) {
  const { locale } = useI18n();
  const [tag] = useState<string | undefined>();
  const api = `/${locale ?? "en"}/api/search`;
  const { search, setSearch, query } = useDocsSearch({
    type: "static",
    from: api,
    locale,
    tag,
    delayMs: 100,
    initOrama: (dbLocale) => {
      if (dbLocale === "cn") {
        return create({
          schema: { _: "string" },
          components: { tokenizer: createCjkSearchTokenizer() },
        });
      }

      return create({
        schema: { _: "string" },
        language: "english",
      });
    },
  });
  const defaultItems = useMemo(() => null, []);

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== "empty" ? query.data : defaultItems} />
      </SearchDialogContent>
      <SearchDialogFooter />
    </SearchDialog>
  );
}
