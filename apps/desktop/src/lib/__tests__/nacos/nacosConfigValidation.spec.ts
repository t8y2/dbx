import { describe, expect, it } from "vitest";
import { validateNacosConfig, validateNacosConfigContent } from "@/lib/nacos/nacosConfigValidation";

describe("Nacos config validation", () => {
  it("accepts valid structured formats", () => {
    expect(validateNacosConfig('{"enabled":true}', "json")).toBeNull();
    expect(validateNacosConfig("service:\n  port: 8080", "yaml")).toBeNull();
    expect(validateNacosConfig("<root><value>1</value></root>", "xml")).toBeNull();
    expect(validateNacosConfig("<html><body>ok</body></html>", "html")).toBeNull();
    expect(validateNacosConfig('<!doctype html><html><head><meta charset="utf-8"><title>DBX</title></head><body><ul><li>one<li>two</ul><br></body></html>', "html")).toBeNull();
    expect(validateNacosConfig("server.port=8080", "properties")).toBeNull();
    expect(validateNacosConfig("feature.enabled", "properties")).toBeNull();
    expect(validateNacosConfig("key=\\\\u12xz", "properties")).toBeNull();
    expect(validateNacosConfig("[server]\nport = 8080", "toml")).toBeNull();
    expect(validateNacosConfig("ports = [\n  8000,\n  8001,\n]", "toml")).toBeNull();
  });

  it("reports JSON and YAML locations", () => {
    const json = validateNacosConfig('{\n  "Version": "1",\n  "name": "zhangsan",\n}', "json");
    expect(json?.message).toContain("Trailing comma");
    expect(json?.line).toBe(3);
    expect(json?.column).toBe(21);
    expect(json?.from).toBe(40);
    expect(json?.to).toBe(41);

    const yaml = validateNacosConfig("service:\n\tport: 8080", "yaml");
    expect(yaml?.message).toContain("spaces");
    expect(yaml?.line).toBe(2);
    expect(yaml?.column).toBe(1);
  });

  it("reports every recoverable JSON syntax error", () => {
    const content = `{
  "Version": "1",
  "Statement": [
    {
      "Action": [
        "pai:*"1
      ],
      "Resource": "acs:paidsw:*:*:*",
      "Effect": "Allow",
      "Condition": {
        "StringEquals": {
          "pai:Accessibility": "PRIVATE",
          "pai:EntityAccessType": "CREATOR"
        }
      }
    },2
    {
      "Action": "next"
    }
  ]
}`;
    const diagnostics = validateNacosConfigContent(content, "json");

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ line: 6, column: 16, from: content.indexOf("1\n") });
    expect(diagnostics[1]).toMatchObject({ line: 16, column: 7, from: content.indexOf("},2") + 2 });
  });

  it("surfaces every YAML diagnostic with its severity, code, and params", () => {
    const duplicateKeys = validateNacosConfigContent("server:\n  port: 8080\n  port: 9090\nserver:\n  host: localhost\n", "yaml");

    expect(duplicateKeys).toHaveLength(2);
    expect(duplicateKeys.map((diagnostic) => diagnostic.code)).toEqual(["duplicateKey", "duplicateKey"]);
    expect(duplicateKeys.map((diagnostic) => diagnostic.severity)).toEqual(["error", "error"]);
    expect(duplicateKeys.map((diagnostic) => diagnostic.params?.key)).toEqual(["port", "server"]);
    expect(duplicateKeys.map((diagnostic) => diagnostic.message)).toEqual(["Duplicate mapping key: port", "Duplicate mapping key: server"]);
    // `validateNacosConfig` keeps its "first diagnostic or null" contract for existing callers.
    expect(validateNacosConfig("server:\n  port: 8080\n  port: 9090\n", "yaml")).toStrictEqual(duplicateKeys[0]);
    expect(validateNacosConfig("server:\n  port: 8080\n  port: 9090\n", "yaml")?.params?.key).toBe("port");

    // A parser warning is surfaced but must not be an error, so it cannot block publishing.
    const [warning] = validateNacosConfigContent("a: !unknownTag bar\n", "yaml");
    expect(warning?.severity).toBe("warning");
    expect(warning?.code).toBe("parserWarning");
    expect(warning?.params?.reason).toBe("Unresolved tag: !unknownTag");

    expect(validateNacosConfigContent("a: 1\n---\nb: 2\n", "yaml")).toEqual([]);
    expect(validateNacosConfigContent("a: 1\n", "yml")).toEqual([]);
  });

  it("rejects malformed XML, HTML, Properties, and TOML", () => {
    expect(validateNacosConfig("<root><child></root>", "xml")?.message).toContain("XML");
    expect(validateNacosConfig("<div>", "html")?.message).toContain("unclosed tag");
    expect(validateNacosConfig("<div><span></div>", "html")?.message).toContain("HTML");
    expect(validateNacosConfig("<script>if (a < b) {}</script>", "html")).toBeNull();
    expect(validateNacosConfig("key=\\u12xz", "properties")?.message).toContain("Unicode");
    expect(validateNacosConfig("server = [", "toml")?.message).toContain("TOML");
    expect(validateNacosConfig('title = "unterminated', "toml")?.message).toContain("TOML");
    expect(validateNacosConfig('title = "invalid\\q"', "toml")?.message).toContain("TOML");
    expect(validateNacosConfig("ports = [1 2]", "toml")?.message).toContain("TOML");
    expect(validateNacosConfig("enabled = truth", "toml")?.message).toContain("TOML");
    expect(validateNacosConfig("[server] trailing", "toml")?.message).toContain("TOML");
    expect(validateNacosConfig('name = "dbx"\nname = "duplicate"', "toml")?.message).toContain("TOML");
  });
});
