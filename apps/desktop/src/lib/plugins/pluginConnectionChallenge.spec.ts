import { describe, expect, it } from "vitest";
import { parsePluginConnectionChallenge, pluginConnectionChallengeKey, PLUGIN_CONNECTION_CHALLENGE_EVENT } from "./pluginConnectionChallenge";
import type { PluginEvent } from "@/types/database";

function challenge(connectionId = "connection-1"): PluginEvent {
  return {
    pluginId: "sample.ssh",
    method: PLUGIN_CONNECTION_CHALLENGE_EVENT,
    params: {
      challengeId: "challenge-1",
      operationId: "operation-1",
      connectionId,
      kind: "host-key",
      host: "server.example",
      port: 22,
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:sample",
    },
  };
}

describe("plugin connection challenges", () => {
  it("accepts only the active plugin and connection", () => {
    expect(parsePluginConnectionChallenge(challenge(), "sample.ssh", "connection-1")?.fingerprint).toBe("SHA256:sample");
    expect(parsePluginConnectionChallenge(challenge("other"), "sample.ssh", "connection-1")).toBeUndefined();
    expect(parsePluginConnectionChallenge(challenge(), "other.plugin", "connection-1")).toBeUndefined();
  });

  it("builds a global de-duplication key scoped to plugin, operation, and challenge", () => {
    const parsed = parsePluginConnectionChallenge(challenge());
    expect(parsed).toBeDefined();
    expect(pluginConnectionChallengeKey(parsed!)).toBe("sample.ssh\u0000operation-1\u0000challenge-1");
  });

  it("rejects malformed operation and challenge tokens", () => {
    const event = challenge();
    event.params = { ...(event.params as Record<string, unknown>), operationId: "bad operation" };
    expect(parsePluginConnectionChallenge(event)).toBeUndefined();
  });
});
