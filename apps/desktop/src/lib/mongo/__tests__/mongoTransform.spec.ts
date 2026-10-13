import { describe, expect, it } from "vitest";
import { transformMongoDocuments, validateMongoTransformRules } from "../mongoTransform";

describe("Mongo masking and reshaping", () => {
  it("preserves source and BSON while applying ordered nested and array rules", async () => {
    const source = [{ _id: { $oid: "507f1f77bcf86cd799439011" }, contact: { email: "private" }, items: [{ secret: 1 }, { secret: 2 }], city: "Paris" }];
    const result = await transformMongoDocuments(source, [
      { path: "contact.email", action: "redact" },
      { path: "items.*.secret", action: "remove" },
      { path: "city", action: "rename", destination: "address.city" },
      { path: "address.city", action: "copy", destination: "shipping.city" },
    ]);
    expect(result).toEqual([{ _id: source[0]._id, contact: { email: "[REDACTED]" }, items: [{}, {}], address: { city: "Paris" }, shipping: { city: "Paris" } }]);
    expect(source[0].contact.email).toBe("private");
  });
  it("uses keyed deterministic hashes and rejects missing secrets", async () => {
    const rules = [{ path: "email", action: "hash" as const }];
    await expect(transformMongoDocuments([{ email: "a" }], rules)).rejects.toThrow("secret");
    const one = await transformMongoDocuments([{ email: "a" }, { email: "a" }], rules, { secret: "test-secret-only-123" });
    const two = await transformMongoDocuments([{ email: "a" }], rules, { secret: "another-secret-1234" });
    expect(one[0].email).toMatch(/^[a-f0-9]{64}$/);
    expect(one[0]).toEqual(one[1]);
    expect(one[0]).not.toEqual(two[0]);
  });
  it("rejects identity changes, prototype paths and destructive path collisions", async () => {
    for (const path of ["_id", "_id.x", "__proto__.x", "x..y", "x.constructor"]) expect(() => validateMongoTransformRules([{ path, action: "remove" }])).toThrow();
    await expect(transformMongoDocuments([{ a: 1, b: 2 }], [{ path: "a", action: "rename", destination: "b" }])).rejects.toThrow("already exists");
    expect(() => validateMongoTransformRules([{ path: "a", action: "copy", destination: "a.b" }])).toThrow();
  });
  it("cancels before producing output and keeps array indices stable", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(transformMongoDocuments([{ a: 1 }], [{ path: "a", action: "remove" }], { signal: controller.signal })).rejects.toThrow();
    expect(await transformMongoDocuments([{ a: [1, 2] }], [{ path: "a.*", action: "remove" }])).toEqual([{ a: [null, null] }]);
  });
});
