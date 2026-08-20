import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("MongoDB OIDC connection form", () => {
  it("keeps the browser authentication hint inside a complete form row", () => {
    expect(dialogSource).toContain(`<div v-if="mongoAuthMechanism === 'MONGODB-OIDC'" class="grid grid-cols-4 items-start gap-4">`);
    expect(dialogSource).not.toContain(`<p v-if="mongoAuthMechanism === 'MONGODB-OIDC'" class="col-start-2 col-span-3`);
  });
});
