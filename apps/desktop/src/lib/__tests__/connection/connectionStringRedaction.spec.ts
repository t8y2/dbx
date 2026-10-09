import { describe, expect, it } from "vitest";
import { redactConnectionStringSecrets } from "@/lib/connection/connectionStringRedaction";

describe("shared connection string redaction", () => {
  it.each([
    ["redis://:synthetic-secret@cache.example.com:6379/0", "redis://:***@cache.example.com:6379/0"],
    ["jdbc:mysql://db.example.com/app?pass%77ord=synthetic-secret&connectTimeout=5000", "jdbc:mysql://db.example.com/app?pass%77ord=***&connectTimeout=5000"],
    ["postgresql://db.example.com/app?sslpassword=key-secret&oauth_client_secret=client-secret", "postgresql://db.example.com/app?sslpassword=***&oauth_client_secret=***"],
    ["jdbc:sqlserver://db.example.com;password={head;tail};encrypt=true", "jdbc:sqlserver://db.example.com;password=***;encrypt=true"],
    ["postgresql://db.example.com/app?passcode=synthetic-secret&role=analyst", "postgresql://db.example.com/app?passcode=***&role=analyst"],
    ["postgresql://db.example.com/app?apikey=synthetic-secret", "postgresql://db.example.com/app?apikey=***"],
    ["postgresql://db.example.com/app?api_key=synthetic-secret", "postgresql://db.example.com/app?api_key=***"],
    ["postgresql://db.example.com/app?api%5Fkey=synthetic-secret", "postgresql://db.example.com/app?api%5Fkey=***"],
    ["postgresql://db.example.com/app?access_token=synthetic-secret", "postgresql://db.example.com/app?access_token=***"],
    ["postgresql://db.example.com/app?client_secret=synthetic-secret", "postgresql://db.example.com/app?client_secret=***"],
    ["postgresql://db.example.com/app?passphrase=synthetic-secret", "postgresql://db.example.com/app?passphrase=***"],
  ])("removes credentials from %s", (connectionString, expected) => {
    expect(redactConnectionStringSecrets(connectionString)).toBe(expected);
  });

  it("leaves unrelated and malformed-escaped non-secret parameters unchanged", () => {
    const url = "postgresql://db.example.com/app?application%ZZ=visible&sslmode=require";
    expect(redactConnectionStringSecrets(url)).toBe(url);
  });
});
