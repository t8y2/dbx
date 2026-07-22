import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { runMongoSidebarMutation } from "../runMongoSidebarMutation";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import type { ConnectionConfig } from "@/types/database";

function connection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "conn-1",
    name: "Mongo",
    db_type: "mongodb",
    host: "localhost",
    port: 27017,
    username: "op",
    password: "",
    ...overrides,
  };
}

describe("runMongoSidebarMutation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("calls onSuccess for void execute results (not treated as cancel)", async () => {
    const loading = ref(false);
    const execute = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    const beforeExecute = vi.fn().mockResolvedValue(undefined);

    await runMongoSidebarMutation({
      connection: connection(),
      database: "app",
      reviewText: 'db.getCollection("users").renameCollection("accounts")',
      source: "Object tree",
      loading,
      beforeExecute,
      execute,
      onSuccess,
    });

    expect(beforeExecute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(undefined);
    expect(loading.value).toBe(false);
  });

  it("passes through non-void execute results to onSuccess", async () => {
    const loading = ref(false);
    const result = { dropped_names: ["a", "b"] };
    const onSuccess = vi.fn();

    await runMongoSidebarMutation({
      connection: connection(),
      database: "app",
      reviewText: 'db.getCollection("users").dropIndexes()',
      source: "Object tree",
      loading,
      execute: async () => result,
      onSuccess,
    });

    expect(onSuccess).toHaveBeenCalledWith(result);
  });

  it("does not execute or call onSuccess when production confirmation is cancelled", async () => {
    const loading = ref(false);
    const execute = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    const beforeExecute = vi.fn();

    const pending = runMongoSidebarMutation({
      connection: connection({ is_production: true }),
      database: "app",
      reviewText: 'db.getCollection("users").drop()',
      source: "Object tree",
      loading,
      beforeExecute,
      execute,
      onSuccess,
    });

    await Promise.resolve();
    expect(useProductionSafetyStore().pending).toBeTruthy();
    expect(loading.value).toBe(false);
    expect(execute).not.toHaveBeenCalled();

    useProductionSafetyStore().cancel();
    await pending;

    expect(beforeExecute).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(loading.value).toBe(false);
  });

  it("executes after production confirmation", async () => {
    const loading = ref(false);
    const execute = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    const pending = runMongoSidebarMutation({
      connection: connection({ is_production: true }),
      database: "app",
      reviewText: 'db.getCollection("users").drop()',
      source: "Object tree",
      loading,
      execute,
      onSuccess,
    });

    await Promise.resolve();
    useProductionSafetyStore().confirm();
    await pending;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("routes existing-target reject to onError without onSuccess", async () => {
    // Mongo rename of an existing target fails at the server (no dropTarget).
    const loading = ref(false);
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const existingTargetError = new Error("Command failed: Namespace app.accounts already exists. target namespace exists");

    await runMongoSidebarMutation({
      connection: connection(),
      database: "app",
      reviewText: 'db.getSiblingDB("app").getCollection("users").renameCollection("accounts")',
      source: "Object tree",
      loading,
      execute: async () => {
        throw existingTargetError;
      },
      onSuccess,
      onError,
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(existingTargetError);
    expect(loading.value).toBe(false);
  });

  it("skips work when already loading", async () => {
    const loading = ref(true);
    const execute = vi.fn();
    const onSuccess = vi.fn();

    await runMongoSidebarMutation({
      connection: connection(),
      database: "app",
      reviewText: "drop",
      source: "Object tree",
      loading,
      execute,
      onSuccess,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
