import { describe, expect, it } from "vitest";
import i18n from "@/i18n";

// The Add Collection dialog looks these up by computed, hyphenated paths.
describe("Add Collection messages", () => {
  it.each(["mongo.createCollectionFormError.capped-size-required", "mongo.createCollectionFormError.collation-locale-required", "mongo.createCollectionNameInvalid.system-prefix", "mongo.createCollectionNameInvalid.null-char", "mongo.createCollectionKind.timeseries"])("resolves %s", (key) => {
    const t = i18n.global.t as (key: string) => string;
    expect(t(key)).not.toBe(key);
    expect(t(key).length).toBeGreaterThan(0);
  });
});
