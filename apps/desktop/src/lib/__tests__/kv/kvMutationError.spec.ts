import { describe, expect, it } from "vitest";
import { classifyKvMutationError, sanitizeKvMutationError } from "@/lib/kv/kvMutationError";

describe("KV mutation errors", () => {
  const noisyConflict = "Agent RPC error (-1): ETCD_CAS_CONFLICT: key changed after it was loaded. recent stderr: SLF4J(W): No SLF4J providers were found. io.netty.resolver.dns.macos.MacOSDnsServerAddressStreamProvider warning";

  it("turns a duplicate create conflict into an actionable message", () => {
    expect(
      classifyKvMutationError(noisyConflict, true, {
        keyAlreadyExists: "同名 Key 已存在，请更换名称，或编辑现有 Key。",
      }),
    ).toEqual({
      kind: "keyAlreadyExists",
      message: "同名 Key 已存在，请更换名称，或编辑现有 Key。",
    });
  });

  it("keeps edit conflicts distinct from duplicate creates", () => {
    expect(classifyKvMutationError(noisyConflict, false, { conflict: "Key 已被修改，请刷新后重试。" })).toEqual({
      kind: "conflict",
      message: "Key 已被修改，请刷新后重试。",
    });
  });

  it("removes RPC wrappers and unrelated Agent stderr from request errors", () => {
    expect(sanitizeKvMutationError("Agent RPC error (-1): etcdserver: request timed out. recent stderr: noisy")).toBe("etcdserver: request timed out");
  });
});
