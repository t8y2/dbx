import type { ConsulCapabilities, ConsulCapabilityStatus, ConsulScope } from "@/types/consul";

export function capabilityVisible(status: ConsulCapabilityStatus): boolean {
  return status !== "unsupported" && status !== "disabled";
}

export function capabilityWritable(status: ConsulCapabilityStatus, readonly: boolean): boolean {
  return !readonly && status === "supported";
}

export function scopeHasWildcard(scope: ConsulScope): boolean {
  return scope.datacenter === "*" || scope.namespace === "*" || scope.partition === "*";
}

export function capabilityStatus(capabilities: ConsulCapabilities | null, key: keyof ConsulCapabilities): ConsulCapabilityStatus {
  const value = capabilities?.[key];
  return value === "supported" || value === "unsupported" || value === "disabled" || value === "forbidden" ? value : "unknown";
}

export function requireConfirmation(expected: string, actual: string): boolean {
  return expected.length > 0 && actual.trim() === expected;
}
