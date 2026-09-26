// @vitest-environment happy-dom
// SDK 注入源码的 transfer 语义回归：fileTransfer.write 曾把 Uint8Array 视图放进
// postMessage 的 transfer 列表，真实 Chromium 以 "Failed to execute 'postMessage'
// on 'Window': Value at index 0 does not have a transferable type." 拒绝，凡走
// fileTransfer 落盘的路径（SFTP 下载 / trzsz 下载 / GIF 导出）全部失败——主 spec
// 的 jsdom postMessage mock 无 transfer 校验，拦不住这类错误，所以这里在
// happy-dom 里 eval 注入源码，并用复刻 Chromium transfer 校验的 parent mock 断言。
import { describe, expect, it } from "vitest";
import { pluginSdkSource } from "./pluginHostBridge";

const TRANSFER_LIST_REJECTION = "Failed to execute 'postMessage' on 'Window': Value at index 0 does not have a transferable type.";

interface PostedMessage {
  message: Record<string, unknown>;
  transfer: unknown[];
}

function evalSdkWithChromiumTransferSemantics(): { posted: PostedMessage[]; dbxPlugin: { fileTransfer: { write: (handleId: string, offset: number, data: Uint8Array | ArrayBuffer | string) => Promise<unknown> } } } {
  const posted: PostedMessage[] = [];
  const parent = {
    postMessage: (message: unknown, _targetOrigin: string, transfer?: unknown[]) => {
      // Chromium 只接受 ArrayBuffer/MessagePort 等少量类型进 transfer 列表；
      // happy-dom 不校验，这里按真实引擎行为复刻拦截。
      for (const item of transfer ?? []) {
        if (!(item instanceof ArrayBuffer)) throw new DOMException(TRANSFER_LIST_REJECTION, "DataCloneError");
      }
      posted.push({ message: message as Record<string, unknown>, transfer: transfer ?? [] });
    },
  };
  const sandboxWindow: Record<string, unknown> = {};
  const source = pluginSdkSource();
  // SDK IIFE 的自由变量（parent/window/document/addEventListener/removeEventListener）
  // 全部由沙箱注入；其余全局（crypto/atob/btoa）走运行时原生。
  new Function("parent", "window", "document", "addEventListener", "removeEventListener", source)(
    parent,
    sandboxWindow,
    window.document,
    () => undefined,
    () => undefined,
  );
  const dbxPlugin = sandboxWindow.dbxPlugin as { fileTransfer: { write: (handleId: string, offset: number, data: Uint8Array | ArrayBuffer | string) => Promise<unknown> } };
  if (!dbxPlugin?.fileTransfer) throw new Error("SDK did not mount window.dbxPlugin");
  return { posted, dbxPlugin };
}

function findWrite(posted: PostedMessage[]): PostedMessage {
  const write = posted.find((entry) => entry.message.method === "host.writeFileChunk");
  if (!write) throw new Error("host.writeFileChunk was never posted");
  return write;
}

describe("pluginSdkSource fileTransfer.write transfer semantics", () => {
  it("posts a standalone ArrayBuffer for a full-span Uint8Array view", () => {
    const { posted, dbxPlugin } = evalSdkWithChromiumTransferSemantics();
    expect(posted.map((entry) => entry.message.type)).toContain("ready");

    const payload = new Uint8Array(16);
    payload[0] = 0xab;
    void dbxPlugin.fileTransfer.write("t1", 0, payload);

    const write = findWrite(posted);
    expect(write.message.params).toMatchObject({ handleId: "t1", offset: 0 });
    expect(write.transfer).toHaveLength(1);
    expect(write.transfer[0]).toBeInstanceOf(ArrayBuffer);
    expect((write.transfer[0] as ArrayBuffer).byteLength).toBe(16);
    expect(write.message.data).toBeInstanceOf(ArrayBuffer);
  });

  it("copies a subview into a standalone buffer covering only the visible range", () => {
    // 越界防护回归：transfer .buffer 会把视图区间之外的 2048 字节一起送出，
    // 必须只送可见的 1024 字节。
    const { posted, dbxPlugin } = evalSdkWithChromiumTransferSemantics();
    const storage = new ArrayBuffer(2048);
    const subview = new Uint8Array(storage, 8, 1024);
    void dbxPlugin.fileTransfer.write("t1", 0, subview);

    const write = findWrite(posted);
    expect(write.transfer[0]).toBeInstanceOf(ArrayBuffer);
    expect(write.transfer[0]).not.toBe(storage);
    expect((write.transfer[0] as ArrayBuffer).byteLength).toBe(1024);
  });

  it("passes a caller-provided ArrayBuffer through untouched", () => {
    const { posted, dbxPlugin } = evalSdkWithChromiumTransferSemantics();
    const buffer = new ArrayBuffer(8);
    void dbxPlugin.fileTransfer.write("t1", 0, buffer);

    const write = findWrite(posted);
    expect(write.transfer[0]).toBe(buffer);
  });

  it("sends dataBase64 strings without a transfer list", () => {
    const { posted, dbxPlugin } = evalSdkWithChromiumTransferSemantics();
    void dbxPlugin.fileTransfer.write("t1", 0, "YQ==");

    const write = findWrite(posted);
    expect(write.message.params).toMatchObject({ handleId: "t1", offset: 0, dataBase64: "YQ==" });
    expect(write.transfer).toHaveLength(0);
  });
});
