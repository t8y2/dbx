import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import en from "../locales/en";
import es from "../locales/es";
import it_ from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import ptBR from "../locales/pt-BR";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

const locales: Array<[string, Record<string, unknown>]> = [
  ["en", en],
  ["es", es],
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

function leafKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key));
}

describe("Consul advanced UI locale parity", () => {
  const expected = leafKeys((en as { consul: { ui: unknown } }).consul.ui).sort();
  const expectedTools = leafKeys((en as { consul: { tools: unknown } }).consul.tools).sort();

  it.each(locales)("%s exposes the full consul.ui key set", (_name, locale) => {
    const ui = (locale as { consul: { ui: unknown } }).consul.ui;
    expect(leafKeys(ui).sort()).toEqual(expected);
  });

  it.each(locales)("%s exposes the full consul.tools key set", (_name, locale) => {
    const tools = (locale as { consul: { tools: unknown } }).consul.tools;
    expect(leafKeys(tools).sort()).toEqual(expectedTools);
  });

  it("uses Chinese labels for the Consul KV workflow", () => {
    const consul = (zhCN as { consul: { tools: Record<string, unknown>; keyLabel: string; valueContent: string; format: string } }).consul;
    const tools = consul.tools;
    expect(tools.search).toBe("全文搜索");
    expect(tools.exportPrefix).toBe("导出");
    expect(tools.import).toBe("导入");
    expect(tools.migrate).toBe("同步");
    expect(tools.deletePrefix).toBe("前缀删除");
    expect(consul.keyLabel).toBe("键（Key）");
    expect(consul.valueContent).toBe("值");
    expect(consul.format).toBe("格式");
  });

  it("localizes Consul service, Session, and capability labels", () => {
    const ui = (zhCN as { consul: { ui: Record<string, unknown> } }).consul.ui;
    expect(ui.serviceKind).toBe("服务类型（ServiceKind）");
    expect(ui.serviceWeights).toBe("通过 / 警告权重");
    expect(ui.behaviorRelease).toBe("释放锁（release）");
    expect(ui.behaviorDelete).toBe("删除 Key（delete）");
    expect(ui.capabilityDisabled).toBe("未启用");
  });

  it.each(["ConsulOverview", "ConsulServices", "ConsulHealth", "ConsulSessions", "ConsulAcl", "ConsulScope", "ConsulMesh", "ConsulTools", "ConsulOperator", "ConsulWorkspace"])("%s uses the i18n composable", (component) => {
    const source = readFileSync(new URL(`../../components/consul/${component}.vue`, import.meta.url), "utf8");
    expect(source).toContain('import { useI18n } from "vue-i18n"');
    expect(source).toContain("useI18n()");
  });

  it("keeps Consul user-facing labels out of component templates", () => {
    const components = ["ConsulServices", "ConsulHealth", "ConsulSessions", "ConsulMesh", "ConsulKeyBrowser", "ConsulOperator"];
    const forbidden = [
      "Catalog nodes",
      "No visible services",
      "No visible nodes",
      "Agent target:",
      "Watch paused",
      "Watching index",
      "Pause watch",
      "Start watch",
      "HTTP Agent registrations belong",
      "Catalog instances",
      "Node services",
      "Local Agent services",
      "Enable maintenance",
      "Disable maintenance",
      "No matching health checks",
      "Service instances",
      "Local Agent checks",
      'placeholder="Watch prefix"',
      ">Key</Badge>",
      ">Value</Badge>",
      'placeholder="UPDATE AUTOPILOT"',
      'placeholder="CHANGE KEYRING"',
      'placeholder="UPDATE LICENSE"',
      ">ServiceKind<",
      ">Passing / Warning<",
      ">Node ID<",
      ">TaggedAddresses<",
      ">EnableTagOverride<",
      ">Behavior<",
      ">CreateIndex<",
      ">ModifyIndex<",
      "Session {{ row.session }}",
    ];

    for (const component of components) {
      const source = readFileSync(new URL(`../../components/consul/${component}.vue`, import.meta.url), "utf8");
      const template = source.slice(source.indexOf("<template>"));
      for (const literal of forbidden) expect(template, `${component} contains ${literal}`).not.toContain(literal);
    }
  });
});
