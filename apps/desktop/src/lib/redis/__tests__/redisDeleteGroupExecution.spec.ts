import { describe, it, expect, afterEach } from "vitest";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { redisDeleteGroupPreview } from "../redisCommandPreview";

function parseRespCommands(buffer: Buffer): { commands: Buffer[][]; remaining: Buffer } {
  const commands: Buffer[][] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0x2a /* '*' */) break;
    const crlfIndex = buffer.indexOf("\r\n", offset);
    if (crlfIndex === -1) break;
    const count = parseInt(buffer.subarray(offset + 1, crlfIndex).toString("utf-8"), 10);
    let curOffset = crlfIndex + 2;
    const args: Buffer[] = [];
    let complete = true;

    for (let i = 0; i < count; i++) {
      if (curOffset >= buffer.length || buffer[curOffset] !== 0x24 /* '$' */) {
        complete = false;
        break;
      }
      const argCrlf = buffer.indexOf("\r\n", curOffset);
      if (argCrlf === -1) {
        complete = false;
        break;
      }
      const len = parseInt(buffer.subarray(curOffset + 1, argCrlf).toString("utf-8"), 10);
      curOffset = argCrlf + 2;
      if (curOffset + len + 2 > buffer.length) {
        complete = false;
        break;
      }
      args.push(buffer.subarray(curOffset, curOffset + len));
      curOffset += len + 2;
    }

    if (!complete) break;
    commands.push(args);
    offset = curOffset;
  }

  return { commands, remaining: buffer.subarray(offset) };
}

function encodeBulkString(data: Buffer | string): Buffer {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return Buffer.concat([Buffer.from(`$${buf.length}\r\n`, "utf-8"), buf, Buffer.from("\r\n", "utf-8")]);
}

function encodeArray(items: (Buffer | string)[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${items.length}\r\n`, "utf-8")];
  for (const item of items) parts.push(encodeBulkString(item));
  return Buffer.concat(parts);
}

function encodeScanResponse(cursor: string, keys: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from("*2\r\n", "utf-8"), encodeBulkString(cursor), encodeArray(keys)]);
}

function computeCrc16Slot(keyBytes: Buffer): number {
  let s = -1;
  let e = -1;
  for (let i = 0; i < keyBytes.length; i++) {
    if (keyBytes[i] === 0x7b && s === -1) {
      s = i;
    } else if (keyBytes[i] === 0x7d && s !== -1) {
      if (i > s + 1) {
        e = i;
        break;
      }
    }
  }
  const tag = s !== -1 && e !== -1 ? keyBytes.subarray(s + 1, e) : keyBytes;
  let crc = 0;
  for (let i = 0; i < tag.length; i++) {
    crc = ((crc << 8) & 0xffff) ^ crc16Table[((crc >>> 8) ^ tag[i]) & 0xff];
  }
  return crc & 0x3fff;
}

const crc16Table = new Uint16Array([
  0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7, 0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef, 0x1231, 0x0210, 0x3273, 0x2252, 0x52b5, 0x4294, 0x72f7, 0x62d6, 0x9339, 0x8318, 0xb37b, 0xa35a, 0xd3bd, 0xc39c, 0xf3ff, 0xe3de, 0x2462, 0x3443, 0x0420, 0x1401, 0x64e6,
  0x74c7, 0x44a4, 0x5485, 0xa56a, 0xb54b, 0x8528, 0x9509, 0xe5ee, 0xf5cf, 0xc5ac, 0xd58d, 0x3653, 0x2672, 0x1611, 0x0630, 0x76d7, 0x66f6, 0x5695, 0x46b4, 0xb75b, 0xa77a, 0x9719, 0x8738, 0xf7df, 0xe7fe, 0xd79d, 0xc7bc, 0x48c4, 0x58e5, 0x6886, 0x78a7, 0x0840, 0x1861, 0x2802, 0x3823, 0xc9cc, 0xd9ed,
  0xe98e, 0xf9af, 0x8948, 0x9969, 0xa90a, 0xb92b, 0x5af5, 0x4ad4, 0x7ab7, 0x6a96, 0x1a71, 0x0a50, 0x3a33, 0x2a12, 0xdbfd, 0xcbdc, 0xfbbf, 0xeb9e, 0x9b79, 0x8b58, 0xbb3b, 0xab1a, 0x6ca6, 0x7c87, 0x4ce4, 0x5cc5, 0x2c22, 0x3c03, 0x0c60, 0x1c41, 0xedae, 0xfd8f, 0xcdec, 0xddcd, 0xad2a, 0xbd0b, 0x8d68,
  0x9d49, 0x7e97, 0x6eb6, 0x5ed5, 0x4ef4, 0x3e13, 0x2e32, 0x1e51, 0x0e70, 0xff9f, 0xefbe, 0xdfdd, 0xcffc, 0xbf1b, 0xaf3a, 0x9f59, 0x8f78, 0x9188, 0x81a9, 0xb1ca, 0xa1eb, 0xd10c, 0xc12d, 0xf14e, 0xe16f, 0x1080, 0x00a1, 0x30c2, 0x20e3, 0x5004, 0x4025, 0x7046, 0x6067, 0x83b9, 0x9398, 0xa3fb, 0xb3da,
  0xc33d, 0xd31c, 0xe37f, 0xf35e, 0x02b1, 0x1290, 0x22f3, 0x32d2, 0x4235, 0x5214, 0x6277, 0x7256, 0xb5ea, 0xa5cb, 0x95a8, 0x8589, 0xf56e, 0xe54f, 0xd52c, 0xc50d, 0x34e2, 0x24c3, 0x14a0, 0x0481, 0x7466, 0x6447, 0x5424, 0x4405, 0xa7db, 0xb7fa, 0x8799, 0x97b8, 0xe75f, 0xf77e, 0xc71d, 0xd73c, 0x26d3,
  0x36f2, 0x0691, 0x16b0, 0x6657, 0x7676, 0x4615, 0x5634, 0xd94c, 0xc96d, 0xf90e, 0xe92f, 0x99c8, 0x89e9, 0xb98a, 0xa9ab, 0x5844, 0x4865, 0x7806, 0x6827, 0x18c0, 0x08e1, 0x3882, 0x28a3, 0xcb7d, 0xdb5c, 0xeb3f, 0xfb1e, 0x8bf9, 0x9bd8, 0xabbb, 0xbb9a, 0x4a75, 0x5a54, 0x6a37, 0x7a16, 0x0af1, 0x1ad0,
  0x2ab3, 0x3a92, 0xfd2e, 0xed0f, 0xdd6c, 0xcd4d, 0xbdaa, 0xad8b, 0x9de8, 0x8dc9, 0x7c26, 0x6c07, 0x5c64, 0x4c45, 0x3ca2, 0x2c83, 0x1ce0, 0x0cc1, 0xef1f, 0xff3e, 0xcf5d, 0xdf7c, 0xaf9b, 0xbfba, 0x8fd9, 0x9ff8, 0x6e17, 0x7e36, 0x4e55, 0x5e74, 0x2e93, 0x3eb2, 0x0ed1, 0x1ef0,
]);

function runBashScript(preview: string, env: Record<string, string | undefined>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("bash", [], { env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.stdin.write(preview);
    child.stdin.end();
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Process exited with code ${code}: ${stderr}`));
    });
    child.on("error", reject);
  });
}

describe("redisDeleteGroupPreview execution fidelity with mock Redis and argv receiver", () => {
  const tempFiles: string[] = [];
  const serversToClose: net.Server[] = [];

  afterEach(() => {
    for (const file of tempFiles) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {}
    }
    tempFiles.length = 0;
    for (const server of serversToClose) {
      try {
        server.close();
      } catch {}
    }
    serversToClose.length = 0;
  });

  function createReceiverScript(): { receiverPath: string; recordPath: string } {
    const tmpDir = os.tmpdir();
    const receiverPath = path.join(tmpDir, `redis_receiver_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
    const recordPath = path.join(tmpDir, `redis_records_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);

    const receiverPy = [
      "#!/usr/bin/env python3",
      "import sys, json, os",
      "record_file = os.environ.get('ARGV_RECORD_FILE')",
      "if record_file:",
      "    records = []",
      "    if os.path.exists(record_file):",
      "        try:",
      "            with open(record_file, 'r') as f:",
      "                records = json.load(f)",
      "        except Exception:",
      "            records = []",
      "    records.append([a.encode('utf-8', 'surrogateescape').decode('latin1') for a in sys.argv])",
      "    with open(record_file, 'w') as f:",
      "        json.dump(records, f)",
    ].join("\n");

    fs.writeFileSync(receiverPath, receiverPy, { mode: 0o755 });
    tempFiles.push(receiverPath, recordPath);
    return { receiverPath, recordPath };
  }

  it("preserves raw bytes and enforces bounded batching (<= 512) with standalone argv receiver", async () => {
    // 6 target keys with complex delimiters: space, newline, quotes, backslash, binary byte
    const specialKeys: Buffer[] = [
      Buffer.from("group:a b"),
      Buffer.from("group:a\nb"),
      Buffer.from('group:a"b'),
      Buffer.from("group:a'b"),
      Buffer.from("group:a\\b"),
      Buffer.from([0x67, 0x72, 0x6f, 0x75, 0x70, 0x3a, 0x80, 0xff]), // group:\x80\xff
    ];
    // Plus 600 bulk keys to verify exact batching (512 limit)
    const bulkKeys: Buffer[] = [];
    for (let i = 0; i < 600; i++) {
      bulkKeys.push(Buffer.from(`group:bulk:${String(i).padStart(3, "0")}`));
    }
    const allTargetKeys = [...specialKeys, ...bulkKeys]; // 606 keys
    expect(allTargetKeys.length).toBe(606);

    let scanCursorReturned = false;
    let selectedDb: number | null = null;
    const socketDelCalls: Buffer[][] = [];

    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const { commands, remaining } = parseRespCommands(buf);
        buf = remaining;

        for (const cmd of commands) {
          const name = cmd[0].toString("utf-8").toUpperCase();
          if (name === "SELECT") {
            selectedDb = parseInt(cmd[1].toString("utf-8"), 10);
            socket.write("+OK\r\n");
          } else if (name === "SCAN") {
            if (!scanCursorReturned) {
              scanCursorReturned = true;
              socket.write(encodeScanResponse("0", allTargetKeys));
            } else {
              socket.write(encodeScanResponse("0", []));
            }
          } else if (name === "DEL") {
            socketDelCalls.push(cmd.slice(1));
            socket.write(`:${cmd.length - 1}\r\n`);
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serversToClose.push(server);
    const port = (server.address() as net.AddressInfo).port;

    const { receiverPath, recordPath } = createReceiverScript();

    const preview = redisDeleteGroupPreview("group:*", {
      database: 3,
      connection: { host: "127.0.0.1", port },
    });

    // Execute the generated script snippet asynchronously
    await runBashScript(preview, {
      REDIS_CLI_RECEIVER: `python3 ${receiverPath}`,
      ARGV_RECORD_FILE: recordPath,
    });

    expect(selectedDb).toBe(3);

    expect(fs.existsSync(recordPath)).toBe(true);
    const records: string[][] = JSON.parse(fs.readFileSync(recordPath, "utf-8"));

    // Exactly 2 batches: 512 and 94 (total 606)
    expect(records.length).toBe(2);

    const batch1 = records[0];
    const batch2 = records[1];

    // Check receiver command line flags
    expect(batch1).toContain("-h");
    expect(batch1).toContain("127.0.0.1");
    expect(batch1).toContain("-p");
    expect(batch1).toContain(String(port));
    expect(batch1).toContain("-n");
    expect(batch1).toContain("3");
    expect(batch1).toContain("DEL");

    // Check keys in batch 1 and batch 2
    const delIdx1 = batch1.indexOf("DEL");
    const keys1 = batch1.slice(delIdx1 + 1);
    expect(keys1.length).toBe(512);

    const delIdx2 = batch2.indexOf("DEL");
    const keys2 = batch2.slice(delIdx2 + 1);
    expect(keys2.length).toBe(94);

    const totalKeys = [...keys1, ...keys2];
    expect(totalKeys.length).toBe(606);

    // CRITICAL FIDELITY CHECKS:
    // 1. "group:a b" is passed as a single argument. It MUST NOT be split into "group:a" and "b"!
    expect(totalKeys).toContain("group:a b");
    expect(totalKeys).not.toContain("group:a");
    expect(totalKeys).not.toContain("b");

    // 2. Newline is preserved intact
    expect(totalKeys).toContain("group:a\nb");

    // 3. Quotes are preserved without shell expansion/corruption
    expect(totalKeys).toContain('group:a"b');
    expect(totalKeys).toContain("group:a'b");

    // 4. Backslash is preserved
    expect(totalKeys).toContain("group:a\\b");

    // 5. Binary high byte key is present intact
    expect(totalKeys.some((k) => k.startsWith("group:") && k.includes("\x80"))).toBe(true);
  });

  it("preserves CRC16 slot grouping and bounds in Cluster mode with argv receiver", async () => {
    // 600 keys with hash tag {slot_alpha} to test bounded batching within a slot (512 limit)
    const clusterKeys: Buffer[] = [];
    for (let i = 0; i < 600; i++) {
      clusterKeys.push(Buffer.from(`cluster:{slot_alpha}:item:${String(i).padStart(3, "0")}`));
    }
    // Plus keys in different hash slots to test single-slot segregation (zero cross-slot mixing)
    clusterKeys.push(Buffer.from("cluster:{slot_beta}:key1"));
    clusterKeys.push(Buffer.from("cluster:{slot_beta}:key2"));
    clusterKeys.push(Buffer.from("cluster:{slot_gamma}:key1"));

    let scanCalled = false;
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const { commands, remaining } = parseRespCommands(buf);
        buf = remaining;

        for (const cmd of commands) {
          const name = cmd[0].toString("utf-8").toUpperCase();
          if (name === "CLUSTER" && cmd[1]?.toString("utf-8").toUpperCase() === "NODES") {
            const port = (server.address() as net.AddressInfo).port;
            const nodeInfo = `0123456789abcdef 127.0.0.1:${port}@1${port} myself,master - 0 1 1 connected 0-16383\n`;
            socket.write(encodeBulkString(nodeInfo));
          } else if (name === "SCAN") {
            if (!scanCalled) {
              scanCalled = true;
              socket.write(encodeScanResponse("0", clusterKeys));
            } else {
              socket.write(encodeScanResponse("0", []));
            }
          } else if (name === "DEL") {
            socket.write(`:${cmd.length - 1}\r\n`);
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serversToClose.push(server);
    const port = (server.address() as net.AddressInfo).port;

    const { receiverPath, recordPath } = createReceiverScript();

    const preview = redisDeleteGroupPreview("cluster:*", {
      isCluster: true,
      connection: { host: "127.0.0.1", port },
    });

    await runBashScript(preview, {
      REDIS_CLI_RECEIVER: `python3 ${receiverPath}`,
      ARGV_RECORD_FILE: recordPath,
    });

    expect(fs.existsSync(recordPath)).toBe(true);
    const records: string[][] = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
    expect(records.length).toBeGreaterThan(0);

    for (const record of records) {
      // Cluster mode MUST pass -c
      expect(record).toContain("-c");
      // Cluster mode MUST NOT pass -n
      expect(record).not.toContain("-n");

      const delIdx = record.indexOf("DEL");
      expect(delIdx).toBeGreaterThan(-1);
      const batchKeys = record.slice(delIdx + 1);

      // Bounded batching: every batch must be <= 512 keys
      expect(batchKeys.length).toBeGreaterThan(0);
      expect(batchKeys.length).toBeLessThanOrEqual(512);

      // Single-slot guarantee: every key in the batch MUST hash to the same slot!
      const firstSlot = computeCrc16Slot(Buffer.from(batchKeys[0], "utf-8"));
      for (const k of batchKeys) {
        const slot = computeCrc16Slot(Buffer.from(k, "utf-8"));
        expect(slot).toBe(firstSlot);
      }
    }
  });

  it("executes bounded deletions directly over RESP socket when no receiver is configured", async () => {
    const specialKeys: Buffer[] = [Buffer.from("group:item_space a b"), Buffer.from("group:item_newline\nxyz"), Buffer.from('group:item_quote"123"')];
    const bulkKeys: Buffer[] = [];
    for (let i = 0; i < 600; i++) {
      bulkKeys.push(Buffer.from(`group:direct:${String(i).padStart(3, "0")}`));
    }
    const targetKeys = [...specialKeys, ...bulkKeys]; // 603 keys

    let scanCalled = false;
    let selectedDb: number | null = null;
    const socketDelBatches: Buffer[][] = [];

    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const { commands, remaining } = parseRespCommands(buf);
        buf = remaining;

        for (const cmd of commands) {
          const name = cmd[0].toString("utf-8").toUpperCase();
          if (name === "SELECT") {
            selectedDb = parseInt(cmd[1].toString("utf-8"), 10);
            socket.write("+OK\r\n");
          } else if (name === "SCAN") {
            if (!scanCalled) {
              scanCalled = true;
              socket.write(encodeScanResponse("0", targetKeys));
            } else {
              socket.write(encodeScanResponse("0", []));
            }
          } else if (name === "DEL") {
            socketDelBatches.push(cmd.slice(1));
            socket.write(`:${cmd.length - 1}\r\n`);
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serversToClose.push(server);
    const port = (server.address() as net.AddressInfo).port;

    const preview = redisDeleteGroupPreview("group:*", {
      database: 1,
      connection: { host: "127.0.0.1", port },
    });

    // Run without REDIS_CLI_RECEIVER: direct socket execution
    await runBashScript(preview, {});

    expect(selectedDb).toBe(1);
    expect(socketDelBatches.length).toBe(2);
    expect(socketDelBatches[0].length).toBe(512);
    expect(socketDelBatches[1].length).toBe(91); // 603 - 512 = 91

    const allDeleted = socketDelBatches.flat().map((b) => b.toString("utf-8"));
    expect(allDeleted).toContain("group:item_space a b");
    expect(allDeleted).toContain("group:item_newline\nxyz");
    expect(allDeleted).toContain('group:item_quote"123"');
  });
});
