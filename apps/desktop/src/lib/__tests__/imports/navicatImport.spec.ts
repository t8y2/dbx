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
    this.elements = flattenTestElements(parseTestConnections(xml));
  }

  querySelector(selector: string) {
    return selector === "parsererror" ? null : null;
  }

  querySelectorAll(selector: string) {
    return selector === "*" ? this.elements : [];
  }
}

function flattenTestElements(elements: TestElement[]): TestElement[] {
  return elements.flatMap((element) => [element, ...flattenTestElements(element.children)]);
}

function parseTestConnections(xml: string): TestElement[] {
  const result: TestElement[] = [];
  // Handle self-closing and paired <Connection> so <Member>/<Advance> children are reachable.
  const connectionRe = /<Connection\b([^>]*?)(\/>|>([\s\S]*?)<\/Connection>)/gi;
  for (const match of xml.matchAll(connectionRe)) {
    const connection = new TestElement("Connection", parseAttributes(match[1] || ""));
    const inner = match[3] || "";
    for (const memberMatch of inner.matchAll(/<Member\b([^>]*?)\/>/gi)) {
      connection.children.push(new TestElement("Member", parseAttributes(memberMatch[1] || "")));
    }
    for (const advanceMatch of inner.matchAll(/<Advance\b([^>]*?)(?:\/>|><\/Advance>)/gi)) {
      connection.children.push(new TestElement("Advance", parseAttributes(advanceMatch[1] || "")));
    }
    result.push(connection);
  }
  return result;
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
  it("imports SQLite DatabaseFile as the host without treating it as a schema", async () => {
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnType="SQLite" Name="local-sqlite" DatabaseFile="C:\\Users\\Yang\\demo.db" />
</Connections>`);

    expect(connection?.db_type).toBe("sqlite");
    expect(connection?.host).toBe("C:\\Users\\Yang\\demo.db");
    expect(connection?.database).toBeUndefined();
    expect(connection?.port).toBe(0);
  });

  it("imports SQLite numeric ConnType file name as host", async () => {
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnType="3" Name="sqlite-by-code" DatabaseFileName="/home/yang/demo.sqlite" />
</Connections>`);

    expect(connection?.db_type).toBe("sqlite");
    expect(connection?.host).toBe("/home/yang/demo.sqlite");
    expect(connection?.database).toBeUndefined();
  });

  it("uses SQLite Database field as the file path", async () => {
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnType="SQLite" Name="sqlite-database-field" Database="/tmp/app.data" />
</Connections>`);

    expect(connection?.db_type).toBe("sqlite");
    expect(connection?.host).toBe("/tmp/app.data");
    expect(connection?.database).toBeUndefined();
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

  it("rebuilds a MongoDB replica-set connection as a multi-host URL from <Member> seeds", async () => {
    const password = await encryptNavicatPassword("replica-secret");
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnectionName="rs-single-demo" ConnType="MONGODB" Host="localhost" UseSRVRecord="false" Port="27017" AuthMechanism="Password" AuthSource="" ConnMethod="ReplicaSet" RetryReads="true" RetryWrites="true" ReadPreference="Primary" ReplicaSetName="" UserName="mongouser" Password="${password}">
    <Member Hostname="replica-1.example.test" Port="3717"/>
    <Advance Database="appdb" UserName="" Password=""/>
  </Connection>
</Connections>`);

    expect(connection?.db_type).toBe("mongodb");
    expect(connection?.name).toBe("rs-single-demo");
    expect(connection?.host).toBe("replica-1.example.test");
    expect(connection?.port).toBe(3717);
    expect(connection?.username).toBe("mongouser");
    expect(connection?.password).toBe("replica-secret");
    expect(connection?.database).toBe("appdb");
    expect(connection?.connection_string).toBe("mongodb://mongouser:replica-secret@replica-1.example.test:3717/appdb?retryWrites=true&retryReads=true");
  });

  it("joins every <Member> seed with commas and keeps the first as the form host", async () => {
    const password = await encryptNavicatPassword("multi-secret");
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnectionName="rs-multi-demo" ConnType="MONGODB" Host="localhost" Port="27017" ConnMethod="ReplicaSet" ReplicaSetName="rs0" AuthSource="admin" AuthMechanism="Password" RetryWrites="true" UserName="mongouser" Password="${password}">
    <Member Hostname="replica-a.example.test" Port="27017"/>
    <Member Hostname="replica-b.example.test" Port="27017"/>
    <Advance Database="appdb"/>
  </Connection>
</Connections>`);

    expect(connection?.host).toBe("replica-a.example.test");
    expect(connection?.port).toBe(27017);
    expect(connection?.connection_string).toBe("mongodb://mongouser:multi-secret@replica-a.example.test:27017,replica-b.example.test:27017/appdb?replicaSet=rs0&authSource=admin&retryWrites=true");
  });

  it("preserves explicitly disabled MongoDB retry settings", async () => {
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnectionName="rs-no-retry" ConnType="MONGODB" Host="localhost" Port="27017" ConnMethod="ReplicaSet" RetryReads="false" RetryWrites="false">
    <Member Hostname="replica.example.test" Port="27017"/>
  </Connection>
</Connections>`);

    expect(connection?.connection_string).toBe("mongodb://replica.example.test:27017?retryWrites=false&retryReads=false");
  });

  it("does not turn replica-set <Member> children into standalone connections", async () => {
    const password = await encryptNavicatPassword("solo-secret");
    const connections = await parseNavicatConnections(`<Connections>
  <Connection ConnectionName="rs-no-leak-demo" ConnType="MONGODB" Host="localhost" Port="27017" ConnMethod="ReplicaSet" UserName="mongouser" Password="${password}">
    <Member Hostname="replica.example.test" Port="27017"/>
    <Advance Database="appdb"/>
  </Connection>
</Connections>`);

    // Previously the 27017-port <Member> was misdetected as a second MongoDB connection.
    expect(connections).toHaveLength(1);
    expect(connections[0]?.name).toBe("rs-no-leak-demo");
    expect(connections[0]?.host).toBe("replica.example.test");
  });

  it("percent-encodes reserved characters in the MongoDB password", async () => {
    const password = await encryptNavicatPassword("p@ss:w/d");
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnectionName="rs-special-chars" ConnType="MONGODB" Host="localhost" Port="27017" ConnMethod="ReplicaSet" UserName="mongouser" Password="${password}">
    <Member Hostname="replica-1.example.test" Port="27017"/>
    <Advance Database="appdb"/>
  </Connection>
</Connections>`);

    expect(connection?.password).toBe("p@ss:w/d");
    expect(connection?.connection_string).toBe("mongodb://mongouser:p%40ss%3Aw%2Fd@replica-1.example.test:27017/appdb");
  });

  it("keeps a member-less standalone MongoDB connection in form mode", async () => {
    const password = await encryptNavicatPassword("standalone-secret");
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnectionName="standalone-demo" ConnType="MONGODB" Host="mongo.example.test" Port="27018" ConnMethod="Standalone" UserName="mongouser" Password="${password}"/>
</Connections>`);

    expect(connection?.db_type).toBe("mongodb");
    expect(connection?.host).toBe("mongo.example.test");
    expect(connection?.port).toBe(27018);
    expect(connection?.username).toBe("mongouser");
    expect(connection?.password).toBe("standalone-secret");
    expect(connection?.connection_string).toBeUndefined();
  });
});
