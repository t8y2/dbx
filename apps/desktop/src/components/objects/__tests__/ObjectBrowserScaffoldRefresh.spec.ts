import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../ObjectBrowser.vue", import.meta.url), "utf8");

function functionBody(name: string): string {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::\\s*[^\\{]+)?\\{`, "m").exec(source);
  if (!signature) throw new Error(`Missing function ${name}`);
  const bodyStart = signature.index + signature[0].length;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }
  throw new Error(`Unclosed function ${name}`);
}

describe("ObjectBrowser scaffold refresh race", () => {
  // Scope A hits stale cache and starts a background revalidate (refreshingObjects = true);
  // before it settles, the user switches to scope B which hits fresh cache and early-returns.
  // A's finally() can no longer run (the load guard's epoch moved on), so the flag must be
  // cleared by the newest request (B) at entry — otherwise the toolbar icon spins forever.
  it("resets the transient refresh flags at entry, before the cache decision", () => {
    const body = functionBody("loadObjects");

    const loadingReset = body.indexOf("loadingObjects.value = false;");
    const refreshingReset = body.indexOf("refreshingObjects.value = false;");
    const cachedBranch = body.indexOf("const cached =");

    expect(loadingReset).toBeGreaterThanOrEqual(0);
    expect(refreshingReset).toBeGreaterThanOrEqual(0);
    // Both resets must precede the cached fresh/stale decision so the newest request
    // owns the spinner state even when a superseded request's finally() cannot run.
    expect(Math.min(loadingReset, refreshingReset)).toBeLessThan(cachedBranch);
    // And neither flag may be turned back on before the branch decides the indicator.
    expect(body.indexOf("refreshingObjects.value = true;")).toBeGreaterThan(cachedBranch);
    expect(body.indexOf("loadingObjects.value = true;")).toBeGreaterThan(cachedBranch);
  });

  it("exposes a non-blocking refresh flag distinct from the blocking full-area load", () => {
    expect(source).toContain("const refreshingObjects = ref(false);");
    expect(functionBody("loadObjects")).toContain("refreshingObjects.value = true;");
    expect(functionBody("loadObjects")).toContain("loadingObjects.value = true;");
  });

  it("keeps visible rows on a background revalidate failure (scaffold-preserving error)", () => {
    expect(source).toContain('const scaffoldRefreshError = ref("");');
    const body = functionBody("loadObjects");
    // A scaffold/refresh revalidate failure must route to the non-blocking banner
    // (scaffoldRefreshError) and keep the visible rows, not replace them with the
    // blocking full-area error.
    expect(body).toContain("scaffoldRefresh = true;");
    expect(body).toContain("if (scaffoldRefresh) {");
    expect(body).toContain("scaffoldRefreshError.value = translateBackendError(t, e)");
    expect(source).toContain('v-if="scaffoldRefreshError"');
  });
});
