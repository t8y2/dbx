import { describe, expect, it } from "vitest";
import { schedulerErrorCode } from "./schedulerApi";

describe("schedulerErrorCode", () => {
  it("reads the desktop machine-code prefix", () => {
    expect(schedulerErrorCode(new Error("version_conflict: stored version 3, got 2"))).toBe("version_conflict");
    expect(schedulerErrorCode(new Error("task_not_found: no row"))).toBe("task_not_found");
  });

  it("reads codes from structured backend errors", () => {
    const error = new Error("save failed");
    error.name = "BackendErrorException";
    (error as unknown as { backendError: { code: string } }).backendError = { code: "run_already_active" };
    expect(schedulerErrorCode(error)).toBe("run_already_active");
  });

  it("recognizes JSON bodies from the web transport", () => {
    expect(schedulerErrorCode(new Error(`500: {"code":"provider_unavailable","message":"sidecar down"}`))).toBe("provider_unavailable");
  });

  it("returns undefined for unrelated errors", () => {
    expect(schedulerErrorCode(new Error("boom"))).toBeUndefined();
    expect(schedulerErrorCode("plain string")).toBeUndefined();
  });
});
