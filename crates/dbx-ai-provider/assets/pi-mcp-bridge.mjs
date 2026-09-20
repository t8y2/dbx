import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const MCP_PROGRAM_ENV = "DBX_PI_MCP_PROGRAM";
const MCP_ARGS_ENV = "DBX_PI_MCP_ARGS";
const ENABLED_TOOLS_ENV = "DBX_PI_ENABLED_TOOLS";
const READY_FILE_ENV = "DBX_PI_BRIDGE_READY_FILE";
const REQUEST_TIMEOUT_MS = 30_000;

function parseJsonEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid ${name}: ${error.message}`);
  }
}

function textFromContent(content) {
  return (content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function piContent(content) {
  const result = [];
  for (const item of content ?? []) {
    if (item?.type === "text" && typeof item.text === "string") {
      result.push({ type: "text", text: item.text });
    } else if (
      item?.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      result.push({ type: "image", data: item.data, mimeType: item.mimeType });
    }
  }
  if (result.length === 0) {
    result.push({ type: "text", text: "" });
  }
  return result;
}

export default async function registerDbxMcpBridge(pi) {
  const program = process.env[MCP_PROGRAM_ENV];
  const readyFile = process.env[READY_FILE_ENV];
  const args = parseJsonEnv(MCP_ARGS_ENV, []);
  const enabledTools = new Set(parseJsonEnv(ENABLED_TOOLS_ENV, []));

  if (!program || !readyFile || !Array.isArray(args) || enabledTools.size === 0) {
    throw new Error("DBX Pi MCP bridge configuration is incomplete");
  }

  const child = spawn(program, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: process.env,
  });
  const pending = new Map();
  let nextId = 1;
  let stderr = "";
  let closed = false;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });

  const rejectPending = (message) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    pending.clear();
  };

  child.on("error", (error) => rejectPending(`DBX MCP process error: ${error.message}`));
  child.on("exit", (code, signal) => {
    closed = true;
    const detail = stderr.trim();
    rejectPending(
      `DBX MCP process exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
    );
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id == null) return;
    const request = pending.get(String(message.id));
    if (!request) return;
    pending.delete(String(message.id));
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    } else {
      request.resolve(message.result);
    }
  });

  const send = (message) => {
    if (closed || !child.stdin.writable) {
      throw new Error("DBX MCP process is not available");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = (method, params = {}, signal) =>
    new Promise((resolve, reject) => {
      const id = String(nextId++);
      let onAbort;
      const cleanup = () => {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      const resolveRequest = (value) => {
        cleanup();
        resolve(value);
      };
      const rejectRequest = (error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`DBX MCP request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        pending.delete(id);
        rejectRequest(error);
        return;
      }
      if (signal) {
        onAbort = () => {
          const active = pending.get(id);
          if (!active) return;
          pending.delete(id);
          rejectRequest(new Error(`DBX MCP request aborted: ${method}`));
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });

  await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "dbx-pi-bridge", version: "1" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  const toolList = await request("tools/list");
  const tools = (toolList?.tools ?? []).filter((tool) => enabledTools.has(tool.name));
  const missing = [...enabledTools].filter((name) => !tools.some((tool) => tool.name === name));
  if (missing.length > 0) {
    throw new Error(`DBX MCP did not expose required tools: ${missing.join(", ")}`);
  }

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.title ?? tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      async execute(_toolCallId, params, signal) {
        const result = await request("tools/call", { name: tool.name, arguments: params ?? {} }, signal);
        if (result?.isError) {
          throw new Error(textFromContent(result.content) || `DBX MCP tool failed: ${tool.name}`);
        }
        return {
          content: piContent(result?.content),
          details: result ?? null,
        };
      },
    });
  }

  await writeFile(readyFile, "ready", "utf8");

  pi.on("session_shutdown", async () => {
    if (closed) return;
    closed = true;
    lines.close();
    child.stdin.end();
    child.kill();
  });
}
