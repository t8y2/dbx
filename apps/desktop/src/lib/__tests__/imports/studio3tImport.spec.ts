import { describe, expect, it } from "vitest";
import { parseStudio3tUriFiles, Studio3tImportError } from "@/lib/imports/studio3tImport";

const parse = (content: string, name = "Example.uri") => parseStudio3tUriFiles([{ name, content }]);

describe("Studio 3T URI import", () => {
  it("preserves replica set servers, authSource, credentials and TLS options", () => {
    const uri = "mongodb://a%3Ab:p%40ss%3Aword@first:27018,second:27019/app?authSource=admin&replicaSet=rs0&tls=true&tlsCAFile=D%3A%5Ccert.pem";
    expect(parse(uri).connections[0]).toEqual({
      id: "__studio3t_import_0",
      name: "Example",
      db_type: "mongodb",
      driver_profile: "mongodb",
      driver_label: "MongoDB",
      host: "first",
      port: 27018,
      username: "a:b",
      password: "p@ss:word",
      database: "app",
      connection_string: uri,
      ssl: true,
    });
  });

  it("keeps Unicode and percent escapes byte for byte", () => {
    const uri = "mongodb://%E7%94%A8%E6%88%B7:%E5%AF%86%E7%A0%81@localhost/?authSource=admin";
    const connection = parse(uri).connections[0];
    expect(connection.username).toBe("用户");
    expect(connection.password).toBe("密码");
    expect(connection.connection_string).toBe(uri);
  });

  it("supports SRV, TLS overrides, IPv6, empty passwords and absent databases", () => {
    expect(parse("mongodb+srv://cluster.example.com/?tls=false").connections[0]).toMatchObject({ ssl: false, database: undefined, username: "", password: "" });
    expect(parse("mongodb+srv://cluster.example.com").connections[0].ssl).toBe(true);
    expect(parse("mongodb://user:@[::1]:27018").connections[0]).toMatchObject({ host: "::1", port: 27018, username: "user", password: "" });
  });

  it("previews several files and lines with unique selection IDs", () => {
    const bundle = parseStudio3tUriFiles([
      { name: "D:\\exports\\prod.uri", content: "\uFEFF# Standard URIs\r\nmongodb://a\r\nmongodb://b\n" },
      { name: "测试.uri", content: "mongodb://c" },
    ]);
    expect(bundle.connections.map((connection) => connection.name)).toEqual(["prod (1)", "prod (2)", "测试"]);
    expect(new Set(bundle.connections.map((connection) => connection.id)).size).toBe(3);
  });

  it("imports a 65-connection Studio 3T v3 export with slash comments and connection metadata", () => {
    const source =
      "// MongoDB Connection URI Export\n// Exported by Studio 3T\n\n" +
      Array.from({ length: 65 }, (_, index) => `// Fixture ${index}\nmongodb://fixture:synthetic%40password@localhost:27017/?retryWrites=false&authSource=admin&3t.uriVersion=3&3t.connection.name=Fixture+${index}&3t.databases=admin&3t.alwaysShowAuthDB=true&3t.alwaysShowDBFromUserRole=true\n`).join(
        "\n",
      );
    const connections = parse(source).connections;
    expect(connections).toHaveLength(65);
    expect(connections.map((connection) => connection.name)).toEqual(Array.from({ length: 65 }, (_, index) => `Fixture ${index}`));
    expect(connections.every((connection) => connection.connection_string === "mongodb://fixture:synthetic%40password@localhost:27017/?retryWrites=false&authSource=admin")).toBe(true);
    expect(connections[0].password).toBe("synthetic@password");
  });

  it("decodes Studio 3T form-encoded names while preserving standard URI option encoding", () => {
    const uri = "mongodb://user:p%2Bss@first,second/app?replicaSet=rs%2Btest&authSource=admin&3t.uriVersion=3&3t.connection.name=%E6%B5%8B%E8%AF%95+%2B+dev";
    expect(parse(uri).connections[0]).toMatchObject({
      name: "测试 + dev",
      password: "p+ss",
      connection_string: "mongodb://user:p%2Bss@first,second/app?replicaSet=rs%2Btest&authSource=admin",
    });
  });

  it("ignores slash comments without requiring proprietary metadata", () => {
    expect(parse("// Standard export\n\n// First connection\nmongodb://localhost\n").connections[0]).toMatchObject({ name: "Example", connection_string: "mongodb://localhost" });
    expect(() => parse("// No connections\n# Just a comment\n")).toThrow("STUDIO3T_IMPORT_invalid");
  });

  it("maps the exported private-key SSH tunnel without passing 3T parameters to MongoDB", () => {
    const uri = "mongodb://u:p@localhost:27018/?authSource=admin&3t.uriVersion=3&3t.connection.name=SSH+fixture&3t.ssh=true&3t.sshAddress=jump.example.test&3t.sshPort=2222&3t.sshAuthMode=privateKey&3t.sshUser=fixture&3t.sshPKPath=D%3A%5CFixture+Keys%5Cid_ed25519&3t.sshUsePKPassphrase=false";
    const connection = parse(uri).connections[0];
    expect(connection.name).toBe("SSH fixture");
    expect(connection.connection_string).toBe("mongodb://u:p@localhost:27018/?authSource=admin");
    expect(connection.transport_layers).toEqual([
      expect.objectContaining({
        type: "ssh",
        id: expect.any(String),
        enabled: true,
        host: "jump.example.test",
        port: 2222,
        user: "fixture",
        key_path: "D:\\Fixture Keys\\id_ed25519",
        auth_method: "key",
      }),
    ]);
  });

  it("keeps a disabled exported SSH tunnel disabled", () => {
    const uri = "mongodb://localhost/?3t.uriVersion=3&3t.ssh=false&3t.sshAddress=jump.example.test";
    expect(parse(uri).connections[0]).toMatchObject({ connection_string: "mongodb://localhost/" });
    expect(parse(uri).connections[0].transport_layers).toBeUndefined();
  });

  it("warns before saving a 3T connection with an invalid default DB and preserves explicit authSource", () => {
    const uri = "mongodb://user:p%40ss@localhost/%24invalid?authSource=admin&replicaSet=rs&3t.uriVersion=3&3t.connection.name=Needs+review";
    const preview = parse(uri);
    expect(preview.invalidDatabaseCount).toBe(1);
    expect(preview.connections[0]).toMatchObject({
      name: "Needs review",
      database: undefined,
      connection_string: "mongodb://user:p%40ss@localhost/?authSource=admin&replicaSet=rs",
      note: expect.stringContaining("$invalid"),
    });
    expect(preview.connections[0].note).not.toContain("p@ss");
    expect(() => parse("mongodb://localhost/%24invalid?3t.uriVersion=3")).toThrow("STUDIO3T_IMPORT_invalid");
    expect(() => parse("mongodb://localhost/%24invalid?authSource=%24invalid&3t.uriVersion=3")).toThrow("STUDIO3T_IMPORT_invalid");
    expect(() => parse("mongodb://localhost/%00invalid?authSource=admin&3t.uriVersion=3")).toThrow("STUDIO3T_IMPORT_invalid");
  });

  it.each([
    "3t.uriVersion=999&3t.connection.name=Fixture",
    "3t.uriVersion=3&3t.unknownTransport=secret",
    "3t.connection.name=Fixture",
    "3t.uriVersion=3&3t.ssh=true&3t.sshAuthMode=unknown",
    "3t.uriVersion=3&3t.ssh=true&3t.sshAuthMode=privateKey&3t.sshAddress=jump&3t.sshUser=u&3t.sshPKPath=key&3t.sshUsePKPassphrase=true",
  ])("rejects unsupported Studio 3T settings without silently discarding transport data: %s", (options) => {
    expect(() => parse(`mongodb://u:secret@localhost/?${options}`)).toThrow("STUDIO3T_IMPORT_unsupported");
  });

  it.each([
    "3t.uriVersion=3&3t.connection.name=A&3t.connection.name=B",
    "3t.uriVersion=3&3t.ssh=maybe",
    "3t.uriVersion=3&3t.ssh=true&3t.sshAuthMode=privateKey&3t.sshAddress=jump&3t.sshPort=0&3t.sshUser=u&3t.sshPKPath=key",
    "3t.uriVersion=3&3t.ssh=true&3t.sshAuthMode=privateKey&3t.sshAddress=jump&3t.sshUser=u",
  ])("rejects ambiguous or incomplete SSH metadata: %s", (options) => {
    expect(() => parse(`mongodb://localhost/?${options}`)).toThrow("STUDIO3T_IMPORT_invalid");
  });

  it.each([
    "",
    "{}",
    "postgres://host",
    "mongodb://",
    "mongodb://a,",
    "mongodb://a:0",
    "mongodb://a:65536",
    "mongodb://a:notaport",
    "mongodb://a/a/b",
    "mongodb://user:secret@a#fragment",
    "mongodb://a/?tls=maybe",
    "mongodb://a/?ssl=true&tls=false",
    "mongodb://a/?bad",
    "mongodb://a/?x=%zz",
    "mongodb://a b",
    "mongodb://u:p@x@y",
    "mongodb+srv://a:27017",
    "mongodb+srv://a,b",
  ])("rejects malformed input without including credentials in errors", (uri) => {
    try {
      parse(uri);
      expect.fail("Expected import failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Studio3tImportError);
      expect((error as Studio3tImportError).code).toBe("invalid");
      expect((error as Error).message).not.toContain("secret");
    }
  });

  it.each(["sshHost", "ssh.host", "proxy", "studio3t.ssh"])("rejects proprietary tunnel options instead of losing them", (key) => {
    expect(() => parse(`mongodb://localhost/?${key}=secret`)).toThrow("STUDIO3T_IMPORT_unsupported");
  });

  it("fails the entire preview if one file cannot be converted", () => {
    expect(() =>
      parseStudio3tUriFiles([
        { name: "ok.uri", content: "mongodb://a" },
        { name: "broken.uri", content: "private encrypted export" },
      ]),
    ).toThrow();
  });

  it("limits aggregate size and connection count", () => {
    expect(() => parse(" ".repeat(10 * 1024 * 1024 + 1))).toThrow("STUDIO3T_IMPORT_tooLarge");
    expect(() => parse("mongodb://a\n".repeat(1001))).toThrow();
    expect(() => parseStudio3tUriFiles([])).toThrow();
  });
});
