import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const mcpBin = fileURLToPath(new URL("../bin/dbx-mcp-server.js", import.meta.url));
const rustBinary = join(process.env.CARGO_TARGET_DIR || resolve(packageDir, "../..", "target"), "debug", process.platform === "win32" ? "dbx-mcp.exe" : "dbx-mcp");

type InitializeResponse = {
  id: number;
  result: {
    serverInfo: {
      name: string;
    };
  };
};

type DiscoverResponse = {
  id: number;
  result: {
    resultType?: string;
    supportedVersions?: string[];
    capabilities?: Record<string, unknown>;
    _meta?: Record<string, { name?: string }>;
  };
};

type ErrorResponse = {
  id: number;
  error: { code: number };
};

test("hides the native server console window on Windows", async () => {
  const launcher = await readFile(mcpBin, "utf8");

  assert.match(launcher, /windowsHide:\s*true/);
});

test("answers server discovery and still serves the legacy initialize flow through an npm-style symlink", async () => {
  const bin = await symlinkedMcpServer();
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = spawn(process.execPath, [bin.path], {
      cwd: packageDir,
      env: {
        ...process.env,
        DBX_MCP_BINARY: rustBinary,
        DBX_DATA_DIR: bin.dir,
      },
    });

    // A client that probes discovery without the `_meta` the final spec made
    // mandatory must still see the pre-upgrade `-32601`, which is the signal it
    // treats as "legacy server, use initialize" and falls back on.
    const bareProbePromise = readJsonRpcResponse<ErrorResponse>(child, 5000);
    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {},
      }),
    );
    const bareProbe = await bareProbePromise;
    assert.equal(bareProbe.id, 1);
    assert.equal(bareProbe.error.code, -32601);

    // Modern agents start with `server/discover` (MCP 2026-07-28) and must get a
    // real discovery result rather than the legacy `-32601` rejection. Per the
    // 2026-07-28 spec every request carries its protocol version and client
    // capabilities in `_meta`.
    const discoveryPromise = readJsonRpcResponse<DiscoverResponse>(child, 5000);
    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "dbx-test", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    );

    const discovery = await discoveryPromise;
    assert.equal(discovery.id, 2);
    assert.ok(discovery.result, `discovery failed: ${JSON.stringify(discovery)}`);
    assert.equal(discovery.result._meta?.["io.modelcontextprotocol/serverInfo"]?.name, "dbx");
    assert.ok(
      discovery.result.supportedVersions?.includes("2026-07-28"),
      `discovery must advertise 2026-07-28, got ${JSON.stringify(discovery.result.supportedVersions)}`,
    );

    // Legacy agents keep using the initialize handshake, unchanged.
    const responsePromise = readJsonRpcResponse<InitializeResponse>(child, 5000);
    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "dbx-test", version: "0.0.0" },
        },
      }),
    );

    const response = await responsePromise;

    assert.equal(response.id, 3);
    assert.equal(response.result.serverInfo.name, "dbx");
  } finally {
    child?.kill();
    await rm(bin.dir, { recursive: true, force: true });
  }
});

async function symlinkedMcpServer() {
  const dir = await mkdtemp(join(tmpdir(), "dbx-mcp-bin-"));
  const path = join(dir, "dbx-mcp-server");
  await symlink(mcpBin, path);
  return { dir, path };
}

function encodeMessage(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

function readJsonRpcResponse<T>(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for initialize response. stderr: ${stderr}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      const lineEnd = stdout.indexOf("\n");
      if (lineEnd === -1) return;
      cleanup();
      resolve(JSON.parse(stdout.slice(0, lineEnd)));
    };

    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`MCP server exited before initialize response. code=${code} signal=${signal} stderr: ${stderr}`));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}
