import type { EtcdAuthPermission, KvValue } from "@/lib/backend/api";

const unboundedRangeEnd = new Uint8Array([0]);

function decodeBase64(value: string): Uint8Array {
  const decoded = globalThis.atob(value.replace(/\s+/g, ""));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function etcdKvValueBytes(value: KvValue): Uint8Array {
  return value.encoding === "base64" ? decodeBase64(value.data) : new TextEncoder().encode(value.data);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return compareBytes(left, right) === 0;
}

function isUnboundedRangeEnd(value: Uint8Array): boolean {
  return bytesEqual(value, unboundedRangeEnd);
}

/** Tests one Key against etcd's byte-oriented, half-open permission range. */
export function etcdPermissionAllowsKey(permission: EtcdAuthPermission, key: KvValue): boolean {
  if (permission.access === "read") return false;
  if (permission.resource === "all") return true;

  const keyBytes = etcdKvValueBytes(key);
  const start = etcdKvValueBytes(permission.key);
  const end = etcdKvValueBytes(permission.rangeEnd);
  if (permission.resource === "key" || end.length === 0) return bytesEqual(keyBytes, start);
  return compareBytes(keyBytes, start) >= 0 && (isUnboundedRangeEnd(end) || compareBytes(keyBytes, end) < 0);
}

export function etcdPermissionsAllowKey(permissions: readonly EtcdAuthPermission[], key: KvValue): boolean {
  return permissions.some((permission) => etcdPermissionAllowsKey(permission, key));
}
