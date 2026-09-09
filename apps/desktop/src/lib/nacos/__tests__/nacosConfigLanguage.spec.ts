import { describe, expect, it } from "vitest";

import { inferNacosConfigFormat, normalizeNacosConfigFormat, resolveNacosConfigFormat } from "../nacosConfigLanguage";

describe("Nacos config format helpers", () => {
  it("normalizes config type aliases and trims or lowercases raw values", () => {
    expect(normalizeNacosConfigFormat()).toBe("");
    expect(normalizeNacosConfigFormat("   ")).toBe("");
    expect(normalizeNacosConfigFormat("txt")).toBe("text");
    expect(normalizeNacosConfigFormat("YML")).toBe("yaml");
    expect(normalizeNacosConfigFormat("Props")).toBe("properties");
    expect(normalizeNacosConfigFormat("  JSON  ")).toBe("json");
    expect(normalizeNacosConfigFormat("toml")).toBe("toml");
  });

  it("infers formats from dataId extensions with aliases and unknown fallback", () => {
    expect(inferNacosConfigFormat("app.yml")).toBe("yaml");
    expect(inferNacosConfigFormat("app.yaml")).toBe("yaml");
    expect(inferNacosConfigFormat("app.TXT")).toBe("text");
    expect(inferNacosConfigFormat("app.properties")).toBe("properties");
    expect(inferNacosConfigFormat("app.json")).toBe("json");
    expect(inferNacosConfigFormat("app.xml")).toBe("xml");
    expect(inferNacosConfigFormat("app.html")).toBe("html");
    expect(inferNacosConfigFormat("app.toml")).toBe("toml");
    expect(inferNacosConfigFormat("app.text")).toBe("text");
    expect(inferNacosConfigFormat("docker.jar")).toBe("");
    expect(inferNacosConfigFormat("no-extension")).toBe("");
    expect(inferNacosConfigFormat()).toBe("");
  });

  it("prefers normalized config type, then dataId inference, then text", () => {
    expect(resolveNacosConfigFormat("yaml", "app.json")).toBe("yaml");
    expect(resolveNacosConfigFormat("YML", "")).toBe("yaml");
    expect(resolveNacosConfigFormat("", "app.yml")).toBe("yaml");
    expect(resolveNacosConfigFormat(undefined, "app")).toBe("text");
    expect(resolveNacosConfigFormat("", "")).toBe("text");
  });
});
