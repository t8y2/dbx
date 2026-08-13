import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../MqttAdminConsole.vue", import.meta.url), "utf8");

describe("MqttAdminConsole i18n regression guards", () => {
  it("does not append a hardcoded （No Local） suffix to the No Local label", () => {
    // Issue #5858 follow-up: the subscription dialog used to render
    // `t("connection.mqttNoLocal")（No Local）`. The CJK-bracket suffix was
    // locale-invariant and leaked Chinese punctuation into every language.
    expect(source).not.toContain("）No Local）");
    expect(source).not.toContain("（No Local）");
  });

  it("renders the No Local label purely through vue-i18n", () => {
    // The en locale value for connection.mqttNoLocal is already "No Local", so
    // dropping the hardcoded suffix loses no information. Guard the intent.
    expect(source).toContain('t("connection.mqttNoLocal")');
    expect(source).not.toContain('t("connection.mqttNoLocal")（No Local）');
  });
});
