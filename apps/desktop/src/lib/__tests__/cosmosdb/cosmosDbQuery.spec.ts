import { describe, expect, it } from "vitest";
import { cosmosDbContainerQueryTemplate } from "@/lib/cosmosdb/cosmosDbQuery";

describe("cosmosDbContainerQueryTemplate", () => {
  it("names identifier-safe containers in FROM", () => {
    expect(cosmosDbContainerQueryTemplate("orders")).toBe("SELECT * FROM orders c");
  });

  it("quotes ids that are not SQL identifiers", () => {
    expect(cosmosDbContainerQueryTemplate("order-items")).toBe('SELECT * FROM "order-items" c');
  });
});
