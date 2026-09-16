import { describe, expect, it } from "vitest";
import { parseGaussdbHosts, serializeGaussdbHosts } from "@/lib/connection/gaussdbHosts";

describe("GaussDB hosts", () => {
  it("keeps a single host and port in separate fields", () => {
    expect(serializeGaussdbHosts([{ host: "db.example.com", port: 5433 }])).toEqual({ host: "db.example.com", port: 5433 });
  });

  it("normalizes a legacy single host:port value", () => {
    expect(parseGaussdbHosts("db.example.com:5433", 5432)).toEqual([{ host: "db.example.com", port: 5433 }]);
  });

  it("serializes multiple hosts with embedded ports", () => {
    expect(
      serializeGaussdbHosts([
        { host: "db1", port: 5432 },
        { host: "db2", port: 5433 },
      ]),
    ).toEqual({ host: "db1:5432,db2:5433", port: 5432 });
  });

  it("round-trips bracketed IPv6 endpoints", () => {
    const entries = parseGaussdbHosts("[2001:db8::1]:5433,[2001:db8::2]:5434", 5432);
    expect(entries).toEqual([
      { host: "2001:db8::1", port: 5433 },
      { host: "2001:db8::2", port: 5434 },
    ]);
    expect(serializeGaussdbHosts(entries).host).toBe("[2001:db8::1]:5433,[2001:db8::2]:5434");
  });
});
