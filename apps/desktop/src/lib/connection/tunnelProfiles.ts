import { uuid } from "@/lib/common/utils";
import type { TransportLayerConfig, TunnelProfile } from "@/types/database";

export type TunnelProfileType = TunnelProfile["type"];

export interface TunnelProfileTestGuard {
  invalidate: () => void;
  start: (profile: TunnelProfile) => number;
  isCurrent: (requestId: number, profile: TunnelProfile | null) => boolean;
}

export function createTunnelProfileTestGuard(): TunnelProfileTestGuard {
  let requestId = 0;
  let testedProfile = "";

  return {
    invalidate: () => {
      requestId++;
      testedProfile = "";
    },
    start: (profile) => {
      testedProfile = JSON.stringify(profile);
      return ++requestId;
    },
    isCurrent: (candidateRequestId, profile) => candidateRequestId === requestId && profile !== null && JSON.stringify(profile) === testedProfile,
  };
}

export function createTunnelProfile(type: TunnelProfileType): TunnelProfile {
  if (type === "proxy") {
    return {
      type: "proxy",
      id: uuid(),
      name: "",
      enabled: true,
      proxy_type: "socks5",
      host: "",
      port: 1080,
      username: "",
      password: "",
    };
  }
  if (type === "http_tunnel") {
    return {
      type: "http_tunnel",
      id: uuid(),
      name: "",
      enabled: true,
      url: "",
      token: "",
      connect_timeout_secs: 10,
    };
  }
  return {
    type: "ssh",
    id: uuid(),
    name: "",
    enabled: true,
    host: "",
    port: 22,
    user: "root",
    password: "",
    key_path: "",
    key_passphrase: "",
    connect_timeout_secs: 5,
    expose_lan: false,
    use_ssh_agent: false,
    ssh_agent_sock_path: "",
    auth_method: "password",
  };
}

export function tunnelProfileSummary(profile: TunnelProfile): string {
  if (profile.type === "ssh") {
    if (!profile.host) return "";
    const user = profile.user ? `${profile.user}@` : "";
    return `${user}${profile.host}:${profile.port || 22}`;
  }
  if (profile.type === "proxy") {
    if (!profile.host) return "";
    return `${profile.proxy_type || "socks5"}://${profile.host}:${profile.port || 1080}`;
  }
  return profile.url || "";
}

export function layerReferencesProfile(layer: TransportLayerConfig): boolean {
  return !!layer.profile_id;
}

/**
 * Builds the reference stub stored on a connection for a layer that uses a
 * shared profile: only identity, enabled state, and the reference survive —
 * the backend swaps in the profile's full configuration at connect time, and
 * keeping credentials out of the stub avoids stale copies.
 */
export function tunnelProfileReferenceLayer(profile: TunnelProfile, previous?: Pick<TransportLayerConfig, "id" | "enabled">): TransportLayerConfig {
  const stub = createTunnelProfile(profile.type);
  stub.id = previous?.id || stub.id;
  stub.enabled = previous?.enabled !== false;
  stub.name = profile.name || "";
  stub.profile_id = profile.id;
  return stub;
}

/**
 * Detaches a profile-referencing layer back into a self-contained custom
 * layer by copying the profile's full configuration onto it.
 */
export function detachTunnelProfileLayer(layer: TransportLayerConfig, profile: TunnelProfile | undefined): TransportLayerConfig {
  if (!profile) {
    const detached = { ...layer };
    delete detached.profile_id;
    return detached;
  }
  const detached = { ...profile, id: layer.id, enabled: layer.enabled !== false };
  delete detached.profile_id;
  return detached;
}
