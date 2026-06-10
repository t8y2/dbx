import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const mcpBin = fileURLToPath(new URL("../dist/index.js", import.meta.url));

type InitializeResponse = {
  id: number;
  result: {
    serverInfo: {
      name: string;
    };
  };
};

test("responds to initialize when invoked through an npm-style symlink", async () => {
  const bin = await symlinkedMcpServer();
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = spawn(process.execPath, [bin.path], {
      cwd: packageDir,
      env: { ...process.env },
    });

    const responsePromise = readJsonRpcResponse(child, 5000);
    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "dbx-test", version: "0.0.0" },
        },
      }),
    );

    const response = await responsePromise;

    assert.equal(response.id, 1);
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

function readJsonRpcResponse(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<InitializeResponse> {
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
