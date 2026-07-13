import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MUTATING_NAME = /(?:Create|Update|Delete|Drop|Insert|Upload|Put|Set|Add|Remove|Flush|Publish|Rollback|Grant|Revoke|Issue|Send|Skip|Reset|Clear|Expire|Unload|Aggregate|RawRequest|ExecuteCommand|HashDel|ListPush|ListSet|ListRemove|Zadd|Zrem|StreamAdd|JsonSet|SetTtl|PubSubPublish)/;
const NON_SQL_PREFIX = /^(?:redis|mongo|document|etcd|zookeeper|nacos|mq)/;

function exportedFunctions(source: string): string[] {
  return [...source.matchAll(/export async function\s+([A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1]);
}

function functionBlock(source: string, marker: string, name: string): string | undefined {
  return source.split(marker).find((candidate) => candidate.includes(name));
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  it("carries production authorization through every MQ and Nacos Tauri mutation", () => {
    const commandSources = [
      ["../mq-tauri.ts", "../../../../../../src-tauri/src/commands/mq_cmd.rs", "../../../../../../crates/dbx-core/src/mq/service.rs"],
      ["../nacos-tauri.ts", "../../../../../../src-tauri/src/commands/nacos_cmd.rs", "../../../../../../crates/dbx-core/src/nacos/service.rs"],
    ] as const;

    for (const [backendPath, commandPath, servicePath] of commandSources) {
      const backendSource = readFileSync(new URL(backendPath, import.meta.url), "utf8");
      const commandSource = readFileSync(new URL(commandPath, import.meta.url), "utf8");
      const serviceSource = readFileSync(new URL(servicePath, import.meta.url), "utf8");
      const mutations = exportedFunctions(backendSource).filter((name) => MUTATING_NAME.test(name));

      for (const name of mutations) {
        const rustName = name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
        const block = functionBlock(commandSource, "#[tauri::command]", `pub async fn ${rustName}(`);
        expect(block, `${rustName} Tauri command must exist`).toBeDefined();
        expect(block, `${rustName} must accept the request-bound token`).toContain("production_write_authorization: Option<ProductionWriteAuthorization>");
        expect(block, `${rustName} must scope the token around its core service call`).toContain("with_production_write_authorization(");
        const serviceBlock = functionBlock(serviceSource, "pub async fn", `${rustName}_core(`);
        expect(serviceBlock, `${rustName}_core service must exist`).toBeDefined();
        expect(serviceBlock, `${rustName}_core must consume operation ${name}`).toContain(`"${name}"`);
      }
    }
  });

  it("binds every directly invoked non-SQL Tauri mutation to its frontend operation", () => {
    const backendSource = readFileSync(new URL("../tauri.ts", import.meta.url), "utf8");
    const commandSource = ["redis_cmd.rs", "mongo_cmd.rs", "document_cmd.rs", "etcd_cmd.rs", "zookeeper_cmd.rs"].map((file) => readFileSync(new URL(`../../../../../../src-tauri/src/commands/${file}`, import.meta.url), "utf8")).join("\n");
    const mutations = exportedFunctions(backendSource).filter((name) => /^(?:redis|mongo|document|etcd|zookeeper)/.test(name) && MUTATING_NAME.test(name));

    for (const name of mutations) {
      const backendBlock = functionBlock(backendSource, "export async function", `${name}(`);
      const command = backendBlock?.match(/\binvoke(?:<[^>]+>)?\(\s*"([^"]+)"/)?.[1];
      // JS aliases are covered through the concrete function they call.
      if (!command) continue;

      const commandBlock = functionBlock(commandSource, "#[tauri::command]", `pub async fn ${command}(`);
      expect(commandBlock, `${command} Tauri command must exist`).toBeDefined();
      expect(commandBlock, `${command} must accept the request-bound token`).toContain("production_write_authorization:");
      expect(commandBlock, `${command} must consume operation ${name}`).toContain(`"${name}"`);
    }
  });

  it("binds every directly invoked non-SQL HTTP mutation to its route operation", () => {
    const backendSource = readFileSync(new URL("../http.ts", import.meta.url), "utf8");
    const webMain = readFileSync(new URL("../../../../../../crates/dbx-web/src/main.rs", import.meta.url), "utf8");
    const routeSources = new Map(["redis", "mongo", "document_store", "etcd", "zookeeper"].map((module) => [module, readFileSync(new URL(`../../../../../../crates/dbx-web/src/routes/${module}.rs`, import.meta.url), "utf8")]));
    const mutations = exportedFunctions(backendSource).filter((name) => /^(?:redis|mongo|document|etcd|zookeeper)/.test(name) && MUTATING_NAME.test(name));

    for (const name of mutations) {
      const backendBlock = functionBlock(backendSource, "export async function", `${name}(`);
      const apiPath = backendBlock?.match(/(?:post|apiUrl)\(\s*"\/api([^"]+)"/)?.[1];
      // JS aliases are covered through the concrete function they call.
      if (!apiPath) continue;

      const route = webMain.match(new RegExp(`\\.route\\("${regexEscape(apiPath)}",\\s*post\\(routes::([a-z_]+)::([a-z_]+)\\)\\)`));
      expect(route, `${apiPath} Web route must exist`).not.toBeNull();
      const [, module = "", handler = ""] = route ?? [];
      const routeBlock = functionBlock(routeSources.get(module) ?? "", "pub async fn", `${handler}(`);
      expect(routeBlock, `${module}::${handler} handler must exist`).toBeDefined();
      expect(routeBlock, `${module}::${handler} must consume operation ${name}`).toContain(`"${name}"`);
    }
  });

  it("keeps REST query and missing Redis web mutations behind token-aware routes", () => {
    const apiSource = readFileSync(new URL("../api.ts", import.meta.url), "utf8");
    const queryCommand = readFileSync(new URL("../../../../../../src-tauri/src/commands/query.rs", import.meta.url), "utf8");
    const webMain = readFileSync(new URL("../../../../../../crates/dbx-web/src/main.rs", import.meta.url), "utf8");
    const webRedis = readFileSync(new URL("../../../../../../crates/dbx-web/src/routes/redis.rs", import.meta.url), "utf8");

    expect(queryCommand.match(/production_write_authorization: Option<dbx_core::production_safety::ProductionWriteAuthorization>/g)).toHaveLength(2);
    expect(queryCommand.match(/with_production_write_authorization\(/g)).toHaveLength(2);
    expect(webMain).toContain('.route("/redis/zrem", post(routes::redis::zrem))');
    expect(webMain).toContain('.route("/redis/set-ttl", post(routes::redis::set_ttl))');
    expect(webRedis).toMatch(/pub async fn zrem[\s\S]*?"redisZrem"/);
    expect(webRedis).toMatch(/pub async fn set_ttl[\s\S]*?"redisSetTtl"/);
    for (const [alias, operation] of [
      ["mongoInsertDocument", "documentInsertDocument"],
      ["mongoUpdateDocument", "documentUpdateDocument"],
      ["mongoDeleteDocument", "documentDeleteDocument"],
    ]) {
      expect(apiSource, `${alias} must authorize the concrete ${operation} command`).toMatch(new RegExp(`forwardProductionWrite\\("${alias}"[\\s\\S]*?"${operation}"`));
    }
  });
});
