import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const useSqlExecutionSource = readFileSync(new URL("../../../composables/useSqlExecution.ts", import.meta.url), "utf8");

describe("toolbar explain routing", () => {
  it("passes the tab id as the execution context, not as SQL", () => {
    // Regression: the injected action once called tryExplain(tabId), whose
    // first parameter is sqlOverride — the id silently typed as SQL and the
    // EXPLAIN button sent the tab UUID to the backend.
    expect(appSource).toContain("explain: (tabId: string) => tryExplain(undefined, { tabId }),");
    expect(appSource).not.toContain("explain: (tabId: string) => tryExplain(tabId),");
  });

  it("keeps tryExplain's first parameter an SQL override", () => {
    expect(useSqlExecutionSource).toContain("async function tryExplain(sqlOverride?: SqlExecutionOverride, options: SqlExecutionOptions = {})");
  });
});
