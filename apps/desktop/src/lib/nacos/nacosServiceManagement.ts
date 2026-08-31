import type { NacosInstanceInfo, NacosInstancePatch, NacosInstanceRef, NacosServiceDetail, NacosServiceUpsert } from "@/types/nacos";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  return value;
}

export function nacosJsonObjectMatches(left: unknown, right: unknown) {
  return JSON.stringify(canonicalJson(left ?? {})) === JSON.stringify(canonicalJson(right ?? {}));
}

export function nacosIpAddressIsValid(value: string) {
  const input = value.trim();
  if (!input) return false;
  if (input.includes(":")) {
    try {
      const parsed = new URL(`http://[${input}]/`);
      return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
    } catch {
      return false;
    }
  }
  const octets = input.split(".");
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && (octet === "0" || !octet.startsWith("0")) && Number(octet) <= 255);
}

export function nacosInstanceRefIdentity(ref: NacosInstanceRef) {
  const lifetime = ref.ephemeral === true ? "ephemeral" : ref.ephemeral === false ? "persistent" : "unknown";
  return [ref.namespace || "public", ref.groupName || "DEFAULT_GROUP", ref.serviceName, ref.ip, ref.port, ref.clusterName || "DEFAULT", lifetime].join("\u0000");
}

export function nacosInstanceMatchesPatch(instance: NacosInstanceInfo, patch: NacosInstancePatch) {
  const weightMatches = patch.weight == null || (instance.weight != null && Math.abs(instance.weight - patch.weight) <= 1e-6);
  const metadataMatches = patch.metadata == null || nacosJsonObjectMatches(instance.metadata, patch.metadata);
  return (patch.enabled == null || instance.enabled === patch.enabled) && (patch.healthy == null || instance.healthy === patch.healthy) && weightMatches && metadataMatches;
}

export function normalizeNacosSelector(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) return null;
  const selector = value as Record<string, unknown>;
  const type = String(selector.type ?? "").toLowerCase();
  const contextType = String(selector.contextType ?? "").toUpperCase();
  if (type === "none" || type === "noneselector" || contextType === "NONE") return null;
  return canonicalJson(selector);
}

export function nacosServiceDetailMatches(detail: NacosServiceDetail, expected: NacosServiceUpsert) {
  const thresholdMatches = expected.protectThreshold == null || (detail.protectThreshold != null && Math.abs(detail.protectThreshold - expected.protectThreshold) <= 1e-6);
  return nacosJsonObjectMatches(detail.metadata, expected.metadata) && thresholdMatches && JSON.stringify(normalizeNacosSelector(detail.selector)) === JSON.stringify(normalizeNacosSelector(expected.selector));
}
