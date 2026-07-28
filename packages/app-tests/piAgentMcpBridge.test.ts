import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const bridgePath = resolve("crates/dbx-core/assets/pi-mcp-bridge.mjs");
const envNames = ["DBX_PI_MCP_PROGRAM", "DBX_PI_MCP_ARGS", "DBX_PI_ENABLED_TOOLS", "DBX_PI_BRIDGE_READY_FILE"] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("Pi Coding Agent MCP bridge", () => {
  it("registers an allowed DBX MCP tool and forwards its result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dbx-pi-bridge-test-"));
    const readyPath = join(directory, "ready");
    const fakeMcp = String.raw`
      const readline = require("node:readline");
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id == null) return;
        let result = {};
        if (request.method === "tools/list") {
          result = {
            tools: [{
              name: "dbx_ping",
              title: "DBX Ping",
              description: "Return a deterministic value",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
            }],
          };
        } else if (request.method === "tools/call") {
          result = {
            content: [{ type: "text", text: "pong:" + request.params.arguments.value }],
            isError: false,
          };
        }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      });
    `;
    process.env.DBX_PI_MCP_PROGRAM = process.execPath;
    process.env.DBX_PI_MCP_ARGS = JSON.stringify(["-e", fakeMcp]);
    process.env.DBX_PI_ENABLED_TOOLS = JSON.stringify(["dbx_ping"]);
    process.env.DBX_PI_BRIDGE_READY_FILE = readyPath;

    const registeredTools: Array<{
      name: string;
      execute: (toolCallId: string, params: unknown, signal: AbortSignal) => Promise<{ content: unknown[]; details: unknown }>;
    }> = [];
    let shutdown: (() => Promise<void>) | undefined;
    const bridge = await import(`${pathToFileURL(bridgePath).href}?test=${Date.now()}`);
    await bridge.default({
      registerTool(tool: (typeof registeredTools)[number]) {
        registeredTools.push(tool);
      },
      on(event: string, handler: () => Promise<void>) {
        if (event === "session_shutdown") shutdown = handler;
      },
    });

    try {
      expect(await readFile(readyPath, "utf8")).toBe("ready");
      expect(registeredTools.map((tool) => tool.name)).toEqual(["dbx_ping"]);
      const result = await registeredTools[0].execute("call-1", { value: "ok" }, new AbortController().signal);
      expect(result.content).toEqual([{ type: "text", text: "pong:ok" }]);
      expect(result.details).toMatchObject({ isError: false });
    } finally {
      await shutdown?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
