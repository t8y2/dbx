import { describe, expect, it } from "vitest";
import { parseNavicatConnections } from "@/lib/imports/navicatImport";

class TestElement {
  readonly tagName: string;
  readonly attributes: { name: string; value: string }[];
  readonly children: TestElement[] = [];
  readonly textContent = "";

  constructor(tagName: string, attributes: { name: string; value: string }[]) {
    this.tagName = tagName;
    this.attributes = attributes;
  }
}

class TestDocument {
  private readonly elements: TestElement[];

  constructor(xml: string) {
    this.elements = Array.from(xml.matchAll(/<Connection\b([\s\S]*?)\/>/gi)).map((match) => new TestElement("Connection", parseAttributes(match[1] || "")));
  }

  querySelector(selector: string) {
    return selector === "parsererror" ? null : null;
  }

  querySelectorAll(selector: string) {
    return selector === "*" ? this.elements : [];
  }
}

class TestDOMParser {
  parseFromString(xml: string) {
    return new TestDocument(xml);
  }
}

function parseAttributes(source: string) {
  return Array.from(source.matchAll(/([^\s=]+)="([^"]*)"/g)).map((match) => ({ name: match[1] || "", value: match[2] || "" }));
}

async function encryptNavicatPassword(value: string) {
  const key = new TextEncoder().encode("libcckeylibcckey");
  const iv = new TextEncoder().encode("libcciv libcciv ");
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cryptoKey, new TextEncoder().encode(value)));
  return Array.from(encrypted, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

if (!globalThis.DOMParser) {
  globalThis.DOMParser = TestDOMParser as typeof DOMParser;
}

describe("parseNavicatConnections", () => {
  it("imports SQLite DatabaseFile as both host and database", async () => {
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnType="SQLite" Name="local-sqlite" DatabaseFile="C:\\Users\\Yang\\demo.db" />
</Connections>`);

    expect(connection?.db_type).toBe("sqlite");
    expect(connection?.host).toBe("C:\\Users\\Yang\\demo.db");
    expect(connection?.database).toBe("C:\\Users\\Yang\\demo.db");
    expect(connection?.port).toBe(0);
  });

  it("imports SQLite numeric ConnType file name as host", async () => {
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnType="3" Name="sqlite-by-code" DatabaseFileName="/home/yang/demo.sqlite" />
</Connections>`);

    expect(connection?.db_type).toBe("sqlite");
    expect(connection?.host).toBe("/home/yang/demo.sqlite");
  });

  it("uses SQLite Database field as the file path", async () => {
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnType="SQLite" Name="sqlite-database-field" Database="/tmp/app.data" />
</Connections>`);

    expect(connection?.db_type).toBe("sqlite");
    expect(connection?.host).toBe("/tmp/app.data");
    expect(connection?.database).toBe("/tmp/app.data");
  });

  it("keeps non-SQLite host and database mapping unchanged", async () => {
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnType="PostgreSQL" Name="pg" Host="db.example.test" Database="appdb" Port="15432" />
</Connections>`);

    expect(connection?.db_type).toBe("postgres");
    expect(connection?.host).toBe("db.example.test");
    expect(connection?.database).toBe("appdb");
    expect(connection?.port).toBe(15432);
    expect(connection?.transport_layers).toEqual([]);
  });

  it("prefers Navicat ConnType over Redis deployment Type", async () => {
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnectionName="redis-standalone" ConnType="REDIS" ServiceProvider="Default" Type="Standalone" Host="redis.example.test" Port="16379" AuthenticationMode="UsernamePassword" UserName="default" />
</Connections>`);

    expect(connection?.db_type).toBe("redis");
    expect(connection?.driver_profile).toBe("redis");
    expect(connection?.name).toBe("redis-standalone");
    expect(connection?.host).toBe("redis.example.test");
    expect(connection?.port).toBe(16379);
    expect(connection?.username).toBe("default");
  });

  it("imports password-authenticated SSH tunnels and decrypts both passwords", async () => {
    const databasePassword = await encryptNavicatPassword("database-secret");
    const sshPassword = await encryptNavicatPassword("ssh-secret");
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnType="MYSQL" ConnectionName="mysql-over-ssh" Host="db.internal" Port="3306" UserName="dbuser" Password="${databasePassword}" SSH="true" SSH_Host="bastion.example.test" SSH_Port="2202" SSH_UserName="sshuser" SSH_AuthenMethod="PASSWORD" SSH_Password="${sshPassword}" />
</Connections>`);

    expect(connection?.password).toBe("database-secret");
    expect(connection?.transport_layers).toEqual([
      expect.objectContaining({
        type: "ssh",
        enabled: true,
        host: "bastion.example.test",
        port: 2202,
        user: "sshuser",
        password: "ssh-secret",
        key_path: "",
        key_passphrase: "",
        auth_method: "password",
      }),
    ]);
  });

  it("imports key-authenticated SSH field variants with the default port", async () => {
    const keyPassphrase = await encryptNavicatPassword("key-secret");
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnType="POSTGRESQL" ConnectionName="variant-ssh" Host="db.internal" UseSSHTunnel="1" SSHTunnelHost="jump.example.test" SSHTunnelUsername="deploy" SSHAuthenticationMethod="PUBLIC_KEY" SSHIdentityFile="~/.ssh/id_ed25519" SSHKeyPassphrase="${keyPassphrase}" />
</Connections>`);

    expect(connection?.transport_layers).toEqual([
      expect.objectContaining({
        type: "ssh",
        enabled: true,
        host: "jump.example.test",
        port: 22,
        user: "deploy",
        password: "",
        key_path: "~/.ssh/id_ed25519",
        key_passphrase: "key-secret",
        auth_method: "key",
      }),
    ]);
  });

  it("imports standard Navicat private-key SSH fields", async () => {
    const keyPassphrase = await encryptNavicatPassword("standard-key-secret");
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnType="MYSQL" ConnectionName="standard-key-ssh" Host="db.internal" SSH="true" SSH_Host="bastion.example.test" SSH_Port="2222" SSH_UserName="deploy" SSH_AuthenMethod="PUBLICKEY" SSH_PrivateKey="C:\\Users\\deploy\\.ssh\\id_rsa" SSH_Passphrase="${keyPassphrase}" />
</Connections>`);

    expect(connection?.transport_layers).toEqual([
      expect.objectContaining({
        type: "ssh",
        enabled: true,
        host: "bastion.example.test",
        port: 2222,
        user: "deploy",
        password: "",
        key_path: "C:\\Users\\deploy\\.ssh\\id_rsa",
        key_passphrase: "standard-key-secret",
        auth_method: "key",
      }),
    ]);
  });

  it("does not create tunnels when SSH is disabled or required fields are missing", async () => {
    const connections = await parseNavicatConnections(`<Connections>
  <Connection ConnType="MYSQL" ConnectionName="disabled-ssh" Host="db-1.internal" SSH="false" SSH_Host="jump.example.test" SSH_UserName="deploy" />
  <Connection ConnType="MYSQL" ConnectionName="missing-ssh-host" Host="db-2.internal" SSH="true" SSH_UserName="deploy" />
  <Connection ConnType="MYSQL" ConnectionName="missing-ssh-user" Host="db-3.internal" SSH="true" SSH_Host="jump.example.test" />
</Connections>`);

    expect(connections).toHaveLength(3);
    expect(connections.map((connection) => connection.transport_layers)).toEqual([[], [], []]);
  });
});
