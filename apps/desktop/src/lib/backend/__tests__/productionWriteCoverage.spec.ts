import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MUTATING_NAME = /(?:Create|Update|Delete|Drop|Insert|Upload|Put|Set|Add|Remove|Flush|Publish|Rollback|Grant|Revoke|Issue|Send|Skip|Reset|Clear|Expire|Unload|RawRequest|ExecuteCommand|HashDel|ListPush|ListSet|ListRemove|Zadd|Zrem|StreamAdd|JsonSet|SetTtl|PubSubPublish)/;
const NON_SQL_PREFIX = /^(?:redis|mongo|document|etcd|zookeeper|nacos|mq)/;

function exportedFunctions(source: string): string[] {
  return [...source.matchAll(/export async function\s+([A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1]);
}

describe("non-SQL production write coverage", () => {
  it("routes every dedicated mutating backend API through the production confirmation wrapper", () => {
    const apiSource = readFileSync(new URL("../api.ts", import.meta.url), "utf8");
    const backendSources = ["../tauri.ts", "../http.ts", "../mq-tauri.ts", "../mq-http.ts", "../nacos-tauri.ts"].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
    const mutatingFunctions = new Set(backendSources.flatMap(exportedFunctions).filter((name) => NON_SQL_PREFIX.test(name) && MUTATING_NAME.test(name)));

    for (const name of mutatingFunctions) {
      expect(apiSource, `${name} must use forwardProductionWrite`).toMatch(new RegExp(`export const ${name}\\s*=\\s*forwardProductionWrite\\(`));
    }
  });
});
