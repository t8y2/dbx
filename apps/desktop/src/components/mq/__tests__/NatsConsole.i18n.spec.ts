import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const consoleSource = readFileSync(new URL("../NatsConsole.vue", import.meta.url), "utf8");
const messagesSource = readFileSync(new URL("../nats/NatsMessagesPanel.vue", import.meta.url), "utf8");
const subjectSource = readFileSync(new URL("../nats/NatsSubjectWorkbench.vue", import.meta.url), "utf8");
const publishSource = readFileSync(new URL("../nats/NatsPublishPanel.vue", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../../i18n/locales/en.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../../i18n/locales/zh-CN.ts", import.meta.url), "utf8");

describe("NatsConsole MQ interaction alignment", () => {
  it("uses the shared MQ admin console shell (toolbar + tabs + content)", () => {
    expect(consoleSource).toContain('class="mq-admin-console"');
    expect(consoleSource).toContain('class="mq-toolbar"');
    expect(consoleSource).toContain('class="mq-tabs"');
    expect(consoleSource).toContain('class="mq-content"');
    expect(consoleSource).toContain('import "./shared/mqConsoleShell.css"');
    expect(consoleSource).toContain('t("mqAdmin.readOnly")');
    expect(consoleSource).toContain('t("mqAdmin.tabMessages")');
  });

  it("hosts Messages and JetStream as tab panels like other MQ consoles", () => {
    expect(consoleSource).toContain('import NatsMessagesPanel from "./nats/NatsMessagesPanel.vue"');
    expect(consoleSource).toContain('import NatsJetStreamPanel from "./nats/NatsJetStreamPanel.vue"');
    expect(consoleSource).toMatch(/activeTab === ['"]messages['"]/);
    expect(consoleSource).toMatch(/activeTab === ['"]jetstream['"]/);
    expect(consoleSource).toContain("ensureConnected");
    expect(consoleSource).toContain("formatError");
  });

  it("keeps the Messages tab interaction order: subscribe/browse then publish", () => {
    const template = messagesSource.split("<template>")[1] || "";
    const subjectAt = template.indexOf("NatsSubjectWorkbench");
    const listAt = template.indexOf("NatsMessageList");
    const publishAt = template.indexOf("NatsPublishPanel");
    expect(subjectAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(subjectAt);
    expect(publishAt).toBeGreaterThan(listAt);
    expect(messagesSource).toContain('t("mqAdmin.tabMessages")');
    expect(messagesSource).toContain("useMqMutationGuard");
  });

  it("routes user-facing labels through nats/mqAdmin i18n keys", () => {
    for (const source of [subjectSource, publishSource, messagesSource]) {
      expect(source).toContain("useI18n");
      expect(source).not.toMatch(/>\s*(Subscribe|Publish|Capture|Load streams)\s*</);
    }
    for (const source of [enSource, zhSource]) {
      expect(source).toContain("nats: {");
      expect(source).toContain("tabJetStream:");
      expect(source).toContain("subjectWorkbench:");
      expect(source).toContain("publish:");
    }
  });
});
