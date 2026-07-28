import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const browserSource = readFileSync(new URL("../KvKeyBrowser.vue", import.meta.url), "utf8");

describe("KvKeyBrowser mutation errors", () => {
  it("shows duplicate-key conflicts next to the Key field", () => {
    expect(browserSource).toContain("classifyKvMutationError(error, isCreating.value");
    expect(browserSource).toContain(`:aria-invalid="editErrorKind === 'keyAlreadyExists'"`);
    expect(browserSource).toContain(`v-if="editError && editErrorKind === 'keyAlreadyExists'"`);
  });

  it("clears the duplicate warning after the Key name changes", () => {
    expect(browserSource).toContain("watch(editKey, () =>");
    expect(browserSource).toContain(`if (editErrorKind.value !== "keyAlreadyExists") return`);
  });
});
