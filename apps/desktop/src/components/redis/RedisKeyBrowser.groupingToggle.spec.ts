import source from "./RedisKeyBrowser.vue?raw";
import { expect, it } from "vitest";

it("uses the fuzzy toggle visual states while preserving grouping persistence and busy guards", () => {
  const button = source.match(/<Button\b[^>]*data-redis-grouping-toggle[^>]*>/s)?.[0];
  expect(button).toBeDefined();
  expect(button).toContain("customGrouping.enabled ? 'bg-accent text-accent-foreground' : 'border border-dashed border-border/70 text-muted-foreground hover:text-foreground'");
  expect(button).toContain(':aria-pressed="customGrouping.enabled"');
  expect(button).toContain(':disabled="groupingSaving || isFetchingAll"');
  expect(button).toContain("saveGrouping({ ...customGrouping, enabled: !customGrouping.enabled })");
});
