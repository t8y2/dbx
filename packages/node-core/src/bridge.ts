import { readFile } from "node:fs/promises";
import { bridgePortFilePath } from "./paths.js";

export async function getBridgeUrl(): Promise<string> {
  const port = (await readFile(bridgePortFilePath(), "utf-8")).trim();
  return `http://127.0.0.1:${port}`;
}

export async function postBridge(path: string, body: Record<string, unknown>): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  try {
    const bridgeUrl = await getBridgeUrl();
    const res = await fetch(`${bridgeUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, text: res.ok ? "" : await res.text() };
  } catch {
    return { ok: false, text: "DBX is not running. Please start DBX first." };
  }
}

export async function notifyReload(): Promise<void> {
  await postBridge("/reload-connections", {});
}
