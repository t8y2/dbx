import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";

export interface KafkaTopicSummary {
  name: string;
  partitionCount: number;
  internal: boolean;
  messageCount?: number | null;
}

export interface KafkaPayload {
  encoding: string;
  data: string;
}

export interface KafkaMessageRecord {
  partition: number;
  offset: number;
  timestamp: number;
  key?: KafkaPayload | null;
  value?: KafkaPayload | null;
  headers: [string, string][];
}

export type KafkaStartOffset = "earliest" | "latest" | { offset: number };

export interface KafkaProduceRequest {
  topic: string;
  key?: string | null;
  value: string;
  headers?: [string, string][];
  partition?: number | null;
}

export interface KafkaProduceResult {
  topic: string;
  partition: number;
  offset: number;
}

function bridgeAppDataDir(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "com.dbx.app");
    case "win32":
      return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "com.dbx.app");
    default:
      return join(home, ".config", "com.dbx.app");
  }
}

async function bridgeDataRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let bridgeUrl: string;
  try {
    const portFile = join(bridgeAppDataDir(), "mcp-bridge-port");
    const port = (await readFile(portFile, "utf-8")).trim();
    bridgeUrl = `http://127.0.0.1:${port}`;
  } catch {
    throw new Error("DBX desktop app is not running. Kafka operations require DBX to be running.");
  }
  const res = await fetch(`${bridgeUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    let errorMsg: string;
    try {
      const parsed = JSON.parse(errBody);
      errorMsg = parsed.error || errBody;
    } catch {
      errorMsg = errBody;
    }
    throw new Error(errorMsg || `Bridge request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function kafkaListTopics(connectionName: string, prefix = "", limit = 100): Promise<KafkaTopicSummary[]> {
  return bridgeDataRequest<KafkaTopicSummary[]>("/data/kafka/list-topics", {
    connection_name: connectionName,
    prefix,
    limit,
  });
}

export async function kafkaFetchMessages(
  connectionName: string,
  topic: string,
  partition: number,
  startOffset: KafkaStartOffset,
  limit = 20,
): Promise<KafkaMessageRecord[]> {
  return bridgeDataRequest<KafkaMessageRecord[]>("/data/kafka/fetch-messages", {
    connection_name: connectionName,
    topic,
    partition,
    start_offset: startOffset,
    limit,
  });
}

export async function kafkaProduceMessage(connectionName: string, req: KafkaProduceRequest): Promise<KafkaProduceResult> {
  return bridgeDataRequest<KafkaProduceResult>("/data/kafka/produce-message", {
    connection_name: connectionName,
    topic: req.topic,
    key: req.key ?? null,
    value: req.value,
    headers: req.headers ?? [],
    partition: req.partition ?? null,
  });
}

export interface KafkaDecodedPayload {
  schemaId?: number | null;
  schemaType?: string | null;
  subject?: string | null;
  decoded?: unknown;
  presentation: string;
  error?: string | null;
}

export function formatKafkaPayload(payload?: KafkaPayload | null): string {
  if (!payload) return "";
  if (payload.encoding === "base64") return `[base64] ${payload.data}`;
  return payload.data;
}

export async function kafkaListSchemaSubjects(connectionName: string, prefix = ""): Promise<string[]> {
  return bridgeDataRequest<string[]>("/data/kafka/list-schema-subjects", {
    connection_name: connectionName,
    prefix,
  });
}

export async function kafkaDecodePayload(
  connectionName: string,
  payload: KafkaPayload,
  subjectHint?: string,
): Promise<KafkaDecodedPayload> {
  return bridgeDataRequest<KafkaDecodedPayload>("/data/kafka/decode-payload", {
    connection_name: connectionName,
    payload,
    subject_hint: subjectHint ?? null,
  });
}
