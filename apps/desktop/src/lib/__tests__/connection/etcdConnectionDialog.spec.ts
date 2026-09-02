import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONNECTION_PICKER_OPTIONS, CONNECTION_PROFILES } from "@/types/generated/connectionProfiles";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
const browserSource = readFileSync(new URL("../../../components/etcd/EtcdKeyBrowser.vue", import.meta.url), "utf8");

describe("etcd connection dialog API versions", () => {
  it("offers v3 and v2 API profile switches", () => {
    expect(dialogSource).toContain("@click=\"switchEtcdApiVersion('etcd')\"");
    expect(dialogSource).toContain("@click=\"switchEtcdApiVersion('etcd-v2')\"");
    expect(dialogSource).toContain("v3 (etcd 3.x)");
    expect(dialogSource).toContain("v2 (etcd 2.x)");
  });

  it("hydrates the v2 profile without exposing a second catalog entry", () => {
    expect(CONNECTION_PROFILES["etcd-v2"]).toMatchObject({ type: "etcd", port: 2379 });
    expect(CONNECTION_PICKER_OPTIONS.some((option) => option.value === "etcd-v2")).toBe(false);
  });
});

describe("etcd v2 feature trimming", () => {
  it("detects the v2 profile from the connection config", () => {
    expect(browserSource).toContain('connectionStore.getConfig(props.connectionId)?.driver_profile === "etcd-v2"');
  });

  it("hides key history for v2 connections", () => {
    expect(browserSource).toContain("history: isV2Api.value ? undefined : api.etcdHistory");
  });

  it("hides lease binding and the maintenance/lease workspaces for v2 connections", () => {
    expect(browserSource).toContain(':supports-lease-binding="!isV2Api"');
    expect(browserSource).toContain('<Button v-if="!isV2Api"');
  });
});
