import { describe, expect, it } from "vitest";
import type { EtcdAuthPermission, KvValue } from "@/lib/backend/api";
import { etcdPermissionAllowsKey, etcdPermissionsAllowKey } from "@/lib/etcd/keyPermissions";

const utf8 = (data: string): KvValue => ({ encoding: "utf8", data });
const base64 = (bytes: number[]): KvValue => ({ encoding: "base64", data: btoa(String.fromCharCode(...bytes)) });

function permission(access: EtcdAuthPermission["access"], key: KvValue, rangeEnd: KvValue, resource: EtcdAuthPermission["resource"]): EtcdAuthPermission {
  return { access, key, rangeEnd, resource };
}

describe("etcd Key write permissions", () => {
  it("matches exact Key grants only", () => {
    const grant = permission("write", utf8("/app/key"), utf8(""), "key");
    expect(etcdPermissionAllowsKey(grant, utf8("/app/key"))).toBe(true);
    expect(etcdPermissionAllowsKey(grant, utf8("/app/key/child"))).toBe(false);
  });

  it("uses etcd's half-open byte ranges", () => {
    const grant = permission("readwrite", utf8("/app/"), utf8("/app0"), "prefix");
    expect(etcdPermissionAllowsKey(grant, utf8("/app/a"))).toBe(true);
    expect(etcdPermissionAllowsKey(grant, utf8("/app0"))).toBe(false);
    expect(etcdPermissionAllowsKey(grant, utf8("/other"))).toBe(false);
  });

  it("supports binary Keys and the unbounded range sentinel", () => {
    const grant = permission("write", base64([0x80]), base64([0]), "prefix");
    expect(etcdPermissionAllowsKey(grant, base64([0x80, 0x01]))).toBe(true);
    expect(etcdPermissionAllowsKey(grant, base64([0x7f]))).toBe(false);
  });

  it("ignores read-only grants when permissions are combined", () => {
    const grants = [permission("read", utf8("/readonly/"), utf8("/readonly0"), "prefix"), permission("readwrite", utf8("/editable/"), utf8("/editable0"), "prefix")];
    expect(etcdPermissionsAllowKey(grants, utf8("/readonly/key"))).toBe(false);
    expect(etcdPermissionsAllowKey(grants, utf8("/editable/key"))).toBe(true);
  });
});
