import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { test } from "vitest";
import type { ConnectionConfig } from "../src/connections.js";
import { executeRedisCommand } from "../src/database.js";

type RedisRequest = { command: string; args: string[] };

function redisConnection(port: number): ConnectionConfig {
  return {
    id: "redis-direct",
    name: "redis-direct",
    db_type: "redis",
    host: "127.0.0.1",
    port,
    username: "",
    password: "",
    database: "0",
    redis_connection_mode: "standalone",
    ssh_enabled: false,
    ssl: false,
  };
}

async function withRedisServer<T>(handler: (request: RedisRequest) => string, fn: (port: number, seen: RedisRequest[]) => Promise<T>): Promise<T> {
  const seen: RedisRequest[] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length > 0) {
        const parsed = parseRespRequest(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.bytes);
        seen.push(parsed.request);
        socket.write(handler(parsed.request));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert(address && "port" in address);
    return await fn(address.port, seen);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function parseRespRequest(buffer: Buffer): { request: RedisRequest; bytes: number } | undefined {
  let offset = 0;
  const firstLine = readLine(buffer, offset);
  if (!firstLine) return undefined;
  offset = firstLine.next;
  const count = Number(firstLine.line.slice(1));
  const parts: string[] = [];

  for (let i = 0; i < count; i++) {
    const lengthLine = readLine(buffer, offset);
    if (!lengthLine) return undefined;
    offset = lengthLine.next;
    const length = Number(lengthLine.line.slice(1));
    if (buffer.length < offset + length + 2) return undefined;
    parts.push(buffer.subarray(offset, offset + length).toString("utf8"));
    offset += length + 2;
  }

  return {
    request: {
      command: parts[0]?.toUpperCase() ?? "",
      args: parts.slice(1),
    },
    bytes: offset,
  };
}

function readLine(buffer: Buffer, offset: number): { line: string; next: number } | undefined {
  const end = buffer.indexOf("\r\n", offset);
  if (end < 0) return undefined;
  return { line: buffer.subarray(offset, end).toString("utf8"), next: end + 2 };
}

function bulk(value: string): string {
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

test("executeRedisCommand runs standalone redis commands without the DBX bridge", async () => {
  await withRedisServer(
    (request) => {
      if (request.command === "CLIENT") return "+OK\r\n";
      if (request.command === "SELECT") return "+OK\r\n";
      assert.deepEqual(request, { command: "GET", args: ["session:1"] });
      return bulk("value-1");
    },
    async (port, seen) => {
      const result = await executeRedisCommand(redisConnection(port), 2, "GET session:1");

      assert.deepEqual(result, { command: "GET", safety: "allowed", value: "value-1" });
      const dataCommands = seen.filter((request) => request.command !== "CLIENT");
      assert.deepEqual(
        dataCommands.map((request) => request.command),
        ["SELECT", "GET"],
      );
      assert.deepEqual(dataCommands[0].args, ["2"]);
    },
  );
});

test("executeRedisCommand parses quoted arguments and JSON bulk replies", async () => {
  await withRedisServer(
    (request) => {
      if (request.command === "CLIENT") return "+OK\r\n";
      if (request.command === "SET") {
        assert.deepEqual(request.args, ["session:1", "hello world"]);
        return "+OK\r\n";
      }
      return bulk('{"ok":true}');
    },
    async (port) => {
      const set = await executeRedisCommand(redisConnection(port), 0, 'SET session:1 "hello world"');
      const get = await executeRedisCommand(redisConnection(port), 0, "GET session:1");

      assert.deepEqual(set, { command: "SET", safety: "write", value: "OK" });
      assert.deepEqual(get, { command: "GET", safety: "allowed", value: { ok: true } });
    },
  );
});

test("executeRedisCommand keeps blocked redis commands behind skipSafetyCheck", async () => {
  await withRedisServer(
    (request) => {
      if (request.command === "CLIENT") return "+OK\r\n";
      return bulk('["session:1"]');
    },
    async (port) => {
      await assert.rejects(() => executeRedisCommand(redisConnection(port), 0, "KEYS *"), /blocked for safety/);

      const result = await executeRedisCommand(redisConnection(port), 0, "KEYS *", { skipSafetyCheck: true });

      assert.deepEqual(result, { command: "KEYS", safety: "blocked", value: ["session:1"] });
    },
  );
});
