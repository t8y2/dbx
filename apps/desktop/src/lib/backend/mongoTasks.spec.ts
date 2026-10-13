import { describe, expect, it } from "vitest";
import { isActiveMongoTaskRun, parseMongoTaskSteps } from "./mongoTasks";
const step = { name: "read", connectionId: "c", database: "test", collection: "items", kind: "find", query: {}, maxRows: 100, timeoutSeconds: 30 };
describe("Mongo task editor", () => {
  it("accepts read-only step shapes and preserves Extended JSON", () => {
    const steps = [
      { ...step, query: { _id: { $oid: "507f1f77bcf86cd799439011" } } },
      { ...step, kind: "aggregate", query: [{ $match: {} }] },
    ];
    expect(parseMongoTaskSteps(JSON.stringify(steps))).toEqual(steps);
  });
  it("rejects empty workflows and unsupported operation kinds", () => {
    expect(() => parseMongoTaskSteps("[]")).toThrow();
    expect(() => parseMongoTaskSteps(JSON.stringify([{ ...step, kind: "deleteMany" }]))).toThrow();
    expect(() => parseMongoTaskSteps(JSON.stringify([{ ...step, query: [] }]))).toThrow();
    expect(() => parseMongoTaskSteps(JSON.stringify([{ ...step, kind: "aggregate", query: {} }]))).toThrow();
  });
  it("bounds step counts, row limits and timeouts", () => {
    expect(() => parseMongoTaskSteps(JSON.stringify(Array.from({ length: 21 }, () => step)))).toThrow();
    for (const maxRows of [0, -1, 1001, 1.2]) expect(() => parseMongoTaskSteps(JSON.stringify([{ ...step, maxRows }]))).toThrow();
    for (const timeoutSeconds of [0, -1, 301, 1.2]) expect(() => parseMongoTaskSteps(JSON.stringify([{ ...step, timeoutSeconds }]))).toThrow();
  });
  it("only regards queued and running jobs as active", () => {
    expect(isActiveMongoTaskRun({ status: "queued" })).toBe(true);
    expect(isActiveMongoTaskRun({ status: "running" })).toBe(true);
    expect(isActiveMongoTaskRun({ status: "interrupted" })).toBe(false);
  });
});
