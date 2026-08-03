import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../../i18n/locales/en.ts", import.meta.url), "utf8");
const zhCnSource = readFileSync(new URL("../../../i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const fallbackLocaleSources = ["es", "it", "ja", "ko", "pt-BR", "zh-TW"].map((locale) => readFileSync(new URL(`../../../i18n/locales/${locale}.ts`, import.meta.url), "utf8"));

describe("ZooKeeper connection dialog", () => {
  it("binds the existing Select component to the ZooKeeper auth_scheme helper", () => {
    expect(dialogSource).toContain("setZooKeeperAuthScheme");
    expect(dialogSource).toContain("resolveZooKeeperAuthScheme");
    expect(dialogSource).toContain("const zookeeperAuthScheme = computed<ZooKeeperAuthScheme>");
    expect(dialogSource).toContain('<Select v-model="zookeeperAuthScheme">');
    expect(dialogSource).toContain('<SelectItem value="digest">');
    expect(dialogSource).toContain('<SelectItem value="sasl_digest">');
  });

  it("uses localized auth labels and tells users both cluster input locations", () => {
    for (const source of [enSource, zhCnSource]) {
      expect(source).toContain("zookeeperAuthMethod:");
      expect(source).toContain("zookeeperAuthDigest:");
      expect(source).toContain("zookeeperAuthSaslDigest:");
      expect(source).toContain("zookeeperClusterInputHint:");
    }
    for (const source of fallbackLocaleSources) {
      expect(source).toContain("withEnglishFallback");
    }
    expect(dialogSource).toContain('t("connection.zookeeperAuthMethod")');
    expect(dialogSource).toContain('t("connection.zookeeperClusterInputHint")');
  });
});
