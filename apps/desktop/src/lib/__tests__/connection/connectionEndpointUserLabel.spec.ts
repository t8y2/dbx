import { describe, expect, it } from "vitest";
import { connectionEndpointUserLabel } from "@/lib/connection/connectionPresentation";

describe("connectionEndpointUserLabel", () => {
  it("returns an empty string without a connection", () => {
    expect(connectionEndpointUserLabel(undefined)).toBe("");
  });

  it("appends the username to a host:port endpoint", () => {
    expect(connectionEndpointUserLabel({ db_type: "mysql", host: "192.168.1.10", port: 3306, username: "root" })).toBe("192.168.1.10:3306@root");
  });

  it("omits @ when the username is blank", () => {
    expect(connectionEndpointUserLabel({ db_type: "mysql", host: "192.168.1.10", port: 3306, username: "" })).toBe("192.168.1.10:3306");
    expect(connectionEndpointUserLabel({ db_type: "mysql", host: "192.168.1.10", port: 3306, username: "   " })).toBe("192.168.1.10:3306");
  });

  it("returns an empty string when no endpoint can be derived", () => {
    expect(connectionEndpointUserLabel({ db_type: "mysql", host: "", port: 0, database: "", username: "root" })).toBe("");
  });

  it("wraps an IPv6 host in brackets before appending the username", () => {
    expect(connectionEndpointUserLabel({ db_type: "postgres", host: "::1", port: 5432, username: "postgres" })).toBe("[::1]:5432@postgres");
  });

  it("keeps the serialized multi-host format for gaussdb", () => {
    expect(connectionEndpointUserLabel({ db_type: "gaussdb", host: "10.0.0.1,10.0.0.2", port: 8000, username: "dbadmin" })).toBe("10.0.0.1:8000,10.0.0.2:8000@dbadmin");
  });

  it("shows the local file path for file-backed connections", () => {
    expect(connectionEndpointUserLabel({ db_type: "sqlite", host: "/data/app.db", port: 0, database: "", username: "" })).toBe("/data/app.db");
    expect(connectionEndpointUserLabel({ db_type: "sqlite", host: "/data/app.db", port: 0, database: "", username: "admin" })).toBe("/data/app.db@admin");
  });

  it("uses the spanner endpoint form when a host is present", () => {
    expect(connectionEndpointUserLabel({ db_type: "spanner", host: "spanner.googleapis.com", port: 443, database: "projects/p/instances/i/databases/d", username: "" })).toBe("spanner.googleapis.com:443");
  });

  it("joins account and database for cloudflare-d1", () => {
    expect(connectionEndpointUserLabel({ db_type: "cloudflare-d1", host: "account-id", port: 0, database: "db-id", username: "" })).toBe("account-id/db-id");
  });
});
