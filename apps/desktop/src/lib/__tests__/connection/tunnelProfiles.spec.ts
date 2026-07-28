import { describe, expect, it } from "vitest";
import { createTunnelProfile, createTunnelProfileTestGuard, detachTunnelProfileLayer, tunnelProfileReferenceLayer, tunnelProfileSummary } from "@/lib/connection/tunnelProfiles";
import type { TunnelProfile } from "@/types/database";

function sshProfile(overrides: Partial<TunnelProfile> = {}): TunnelProfile {
  return {
    ...createTunnelProfile("ssh"),
    id: "profile-1",
    name: "Bastion",
    host: "bastion.example.com",
    user: "deploy",
    password: "s3cret",
    ...overrides,
  } as TunnelProfile;
}

describe("tunnelProfileSummary", () => {
  it("formats ssh profiles as user@host:port", () => {
    expect(tunnelProfileSummary(sshProfile())).toBe("deploy@bastion.example.com:22");
  });

  it("formats proxy profiles as scheme://host:port", () => {
    const proxy = { ...createTunnelProfile("proxy"), host: "127.0.0.1", port: 1080 } as TunnelProfile;
    expect(tunnelProfileSummary(proxy)).toBe("socks5://127.0.0.1:1080");
  });

  it("returns the url for http tunnel profiles", () => {
    const http = { ...createTunnelProfile("http_tunnel"), url: "https://example.com/dbx_tunnel.php" } as TunnelProfile;
    expect(tunnelProfileSummary(http)).toBe("https://example.com/dbx_tunnel.php");
  });

  it("returns an empty string when the target is not configured yet", () => {
    expect(tunnelProfileSummary(createTunnelProfile("ssh"))).toBe("");
  });
});

describe("createTunnelProfileTestGuard", () => {
  it("invalidates a request when the tested profile changes", () => {
    const guard = createTunnelProfileTestGuard();
    const profile = sshProfile();
    const requestId = guard.start(profile);

    expect(guard.isCurrent(requestId, profile)).toBe(true);
    expect(guard.isCurrent(requestId, { ...profile, password: "changed" } as TunnelProfile)).toBe(false);
  });

  it("invalidates a request after switching or removing the profile", () => {
    const guard = createTunnelProfileTestGuard();
    const requestId = guard.start(sshProfile());

    guard.invalidate();

    expect(guard.isCurrent(requestId, sshProfile())).toBe(false);
    expect(guard.isCurrent(requestId, null)).toBe(false);
  });

  it("ignores an older response after a newer request starts", () => {
    const guard = createTunnelProfileTestGuard();
    const profile = sshProfile();
    const olderRequestId = guard.start(profile);
    const newerRequestId = guard.start(profile);

    expect(guard.isCurrent(olderRequestId, profile)).toBe(false);
    expect(guard.isCurrent(newerRequestId, profile)).toBe(true);
  });
});

describe("tunnelProfileReferenceLayer", () => {
  it("keeps only identity, enabled state, and the reference", () => {
    const profile = sshProfile();
    const stub = tunnelProfileReferenceLayer(profile, { id: "layer-1", enabled: false });

    expect(stub.id).toBe("layer-1");
    expect(stub.enabled).toBe(false);
    expect(stub.profile_id).toBe("profile-1");
    expect(stub.name).toBe("Bastion");
    // Credentials must not be copied into the stub stored on the connection.
    expect(stub.type).toBe("ssh");
    if (stub.type === "ssh") {
      expect(stub.host).toBe("");
      expect(stub.password).toBe("");
    }
  });

  it("generates a fresh id when there is no previous layer", () => {
    const stub = tunnelProfileReferenceLayer(sshProfile());
    expect(stub.id).toBeTruthy();
    expect(stub.enabled).toBe(true);
  });
});

describe("detachTunnelProfileLayer", () => {
  it("copies the profile configuration onto the layer and drops the reference", () => {
    const profile = sshProfile();
    const stub = tunnelProfileReferenceLayer(profile, { id: "layer-1", enabled: true });
    const detached = detachTunnelProfileLayer(stub, profile);

    expect(detached.id).toBe("layer-1");
    expect(detached.profile_id).toBeUndefined();
    if (detached.type === "ssh") {
      expect(detached.host).toBe("bastion.example.com");
      expect(detached.password).toBe("s3cret");
    } else {
      throw new Error("expected ssh layer");
    }
  });

  it("only drops the reference when the profile no longer exists", () => {
    const stub = tunnelProfileReferenceLayer(sshProfile(), { id: "layer-1", enabled: true });
    const detached = detachTunnelProfileLayer(stub, undefined);
    expect(detached.profile_id).toBeUndefined();
    expect(detached.id).toBe("layer-1");
  });
});
