import { describe, expect, it } from "vitest";
import { detectKvValueFormat, formatKvValue, validateKvValue } from "@/lib/kv/kvValueFormat";

describe("kv value formats", () => {
  it("detects structured UTF-8 values", () => {
    expect(detectKvValueFormat('{"enabled":true}')).toBe("json");
    expect(detectKvValueFormat("service:\n  port: 8080")).toBe("yaml");
    expect(detectKvValueFormat("port: 8080\nenabled: true")).toBe("yaml");
    expect(detectKvValueFormat("<root><value>1</value></root>")).toBe("xml");
    expect(detectKvValueFormat("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app")).toBe("kubernetes");
    expect(detectKvValueFormat("SELECT * FROM users;")).toBe("sql");
    expect(detectKvValueFormat("server.port=8080\nfeature.enabled=true")).toBe("properties");
    expect(detectKvValueFormat("#!/usr/bin/env bash\nset -euo pipefail")).toBe("shell");
    expect(detectKvValueFormat("FROM alpine:3.22\nRUN echo ok")).toBe("dockerfile");
    expect(detectKvValueFormat("server {\n  listen 80;\n}")).toBe("nginx");
    expect(detectKvValueFormat("hello")).toBe("text");
  });

  it("validates and formats JSON", () => {
    expect(validateKvValue('{"ok":true}', "json")).toBeNull();
    expect(validateKvValue("{", "json")).toBeTruthy();
    expect(formatKvValue('{"ok":true}', "json")).toBe('{\n  "ok": true\n}');
  });

  it("validates base64 without decoding it through UTF-8", () => {
    expect(validateKvValue("AP+A", "base64")).toBeNull();
    expect(validateKvValue("***", "base64")).toBeTruthy();
  });

  it("validates configuration-oriented formats", () => {
    expect(validateKvValue("apiVersion: v1\nkind: ConfigMap", "kubernetes")).toBeNull();
    expect(validateKvValue("kind: ConfigMap", "kubernetes")).toContain("apiVersion");
    expect(validateKvValue("server.port=8080", "properties")).toBeNull();
    expect(validateKvValue("server.port", "properties")).toContain("Properties");
    expect(validateKvValue("FROM alpine\nRUN echo ok", "dockerfile")).toBeNull();
    expect(validateKvValue("UNKNOWN value", "dockerfile")).toContain("Dockerfile");
    expect(validateKvValue("server {\n  listen 80;\n}", "nginx")).toBeNull();
    expect(validateKvValue("server {", "nginx")).toContain("unbalanced");
  });
});
