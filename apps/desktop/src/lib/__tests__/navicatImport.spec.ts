import { describe, expect, it } from "vitest";
import { parseNavicatConnections } from "../navicatImport";

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
});
