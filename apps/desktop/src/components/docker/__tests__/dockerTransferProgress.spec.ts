import { describe, expect, it } from "vitest";
import { createDockerProgressParseState, parseDockerProgressEvent } from "@/components/docker/dockerTransferProgress";

describe("Docker transfer progress", () => {
  it("keeps a split Docker stream error terminal after the SSE completion event", () => {
    const state = createDockerProgressParseState();
    const sessionId = "pull-session";
    const image = "private.example/app:latest";

    const first = parseDockerProgressEvent(state, {
      sessionId,
      kind: "pull",
      image,
      chunk: '{"status":"Pulling","id":"layer-1"}\n{"errorDetail":{"mess',
      done: false,
    });
    expect(first.status).toBe("running");

    const denied = parseDockerProgressEvent(state, {
      sessionId,
      kind: "pull",
      image,
      chunk: 'age":"pull access denied"},"error":"pull access denied"}\n',
      done: false,
      current: first,
    });
    expect(denied.status).toBe("error");
    expect(denied.error).toBe("pull access denied");

    const completed = parseDockerProgressEvent(state, {
      sessionId,
      kind: "pull",
      image,
      chunk: "",
      done: true,
      current: denied,
    });
    expect(completed.status).toBe("error");
    expect(completed.error).toBe("pull access denied");
  });
});
