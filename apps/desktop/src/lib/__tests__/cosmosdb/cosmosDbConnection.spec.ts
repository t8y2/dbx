import { describe, expect, it } from "vitest";
import { parseCosmosDbEndpointInput } from "@/lib/cosmosdb/cosmosDbConnection";

describe("parseCosmosDbEndpointInput", () => {
  it("accepts a bare account host", () => {
    expect(parseCosmosDbEndpointInput("acct.documents.azure.com")).toEqual({ host: "acct.documents.azure.com", port: 443, ssl: true });
  });

  it("accepts the portal URI", () => {
    expect(parseCosmosDbEndpointInput("https://acct.documents.azure.com:443/")).toEqual({ host: "acct.documents.azure.com", port: 443, ssl: true });
  });

  it("splits a portal connection string and keeps the key padding", () => {
    expect(parseCosmosDbEndpointInput("AccountEndpoint=https://acct.documents.azure.com:443/;AccountKey=abc+/def==;")).toEqual({
      host: "acct.documents.azure.com",
      port: 443,
      ssl: true,
      accountKey: "abc+/def==",
    });
  });

  it("keeps the emulator port and an explicit http scheme", () => {
    expect(parseCosmosDbEndpointInput("https://localhost:8081/")).toEqual({ host: "localhost", port: 8081, ssl: true });
    expect(parseCosmosDbEndpointInput("http://127.0.0.1:8081")).toEqual({ host: "127.0.0.1", port: 8081, ssl: false });
  });

  it("rejects unrecognizable input", () => {
    expect(parseCosmosDbEndpointInput("")).toBeNull();
    expect(parseCosmosDbEndpointInput("AccountKey=abc==")).toBeNull();
    expect(parseCosmosDbEndpointInput("mongodb://acct.mongo.cosmos.azure.com:10255")).toBeNull();
  });
});
