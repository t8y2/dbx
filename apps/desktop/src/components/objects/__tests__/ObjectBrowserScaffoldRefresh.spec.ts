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
  it("restores cached rows without revalidating on a tab remount", () => {
    const body = functionBody("loadObjects");

    const cachedBranch = body.indexOf("const cached =");
    const cachedReturn = body.indexOf("finishOnce();\n    return;", cachedBranch);

    expect(cachedBranch).toBeGreaterThanOrEqual(0);
    expect(cachedReturn).toBeGreaterThan(cachedBranch);
    expect(body.slice(cachedBranch, cachedReturn)).not.toContain("cached.stale");
    expect(body.slice(cachedBranch, cachedReturn)).not.toContain("refreshingObjects.value = true;");
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
