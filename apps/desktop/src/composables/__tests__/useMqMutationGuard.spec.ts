// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const requestConfirmation = vi.fn();

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: (id: string) => {
      if (id === "missing") return undefined;
      if (id === "readonly") return { name: "ro", read_only: true, is_production: false };
      if (id === "prod") return { name: "prod-mq", read_only: false, is_production: true };
      return { name: "dev-mq", read_only: false, is_production: false };
    },
  }),
}));

vi.mock("@/stores/productionSafetyStore", () => ({
  useProductionSafetyStore: () => ({ requestConfirmation }),
}));

import { useMqMutationGuard } from "@/composables/useMqMutationGuard";

describe("useMqMutationGuard", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    requestConfirmation.mockReset();
    requestConfirmation.mockResolvedValue(true);
  });

  it("denies missing and read-only connections without prompting", async () => {
    const missing = useMqMutationGuard("missing");
    const readonly = useMqMutationGuard("readonly");
    await expect(missing.confirmMqWrite("send")).resolves.toBe(false);
    await expect(readonly.confirmMqWrite("send")).resolves.toBe(false);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it("allows non-production writes immediately", async () => {
    const guard = useMqMutationGuard("dev");
    await expect(guard.confirmMqWrite("send")).resolves.toBe(true);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it("prompts for production writes", async () => {
    const guard = useMqMutationGuard("prod");
    await expect(guard.confirmMqWrite("send")).resolves.toBe(true);
    expect(requestConfirmation).toHaveBeenCalledWith({
      sql: "send",
      connectionName: "prod-mq",
      source: "mq",
    });
  });
});
