import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribePluginEvents } from "@/lib/backend/http";

describe("web plugin event stream (#14027)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shares one EventSource across plugin hosts and closes it after the last one leaves", async () => {
    const sources: FakeEventSource[] = [];
    class FakeEventSource {
      onmessage: ((event: { data: string }) => void) | null = null;
      close = vi.fn();

      constructor(readonly url: string) {
        sources.push(this);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const hosts = [vi.fn(), vi.fn(), vi.fn()];
    const binary = vi.fn();

    const unsubscribers = [await subscribePluginEvents(hosts[0], binary), await subscribePluginEvents(hosts[1]), await subscribePluginEvents(hosts[2])];

    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("/api/plugins/events");
    sources[0].onmessage?.({ data: JSON.stringify({ kind: "event", pluginId: "demo", event: "changed", payload: 1 }) });
    sources[0].onmessage?.({ data: JSON.stringify({ kind: "binary", pluginId: "demo", channel: "pty", dataBase64: "" }) });
    for (const host of hosts) expect(host).toHaveBeenCalledTimes(1);
    expect(binary).toHaveBeenCalledTimes(1);

    unsubscribers[0]();
    unsubscribers[0]();
    unsubscribers[1]();
    expect(sources[0].close).not.toHaveBeenCalled();
    sources[0].onmessage?.({ data: JSON.stringify({ kind: "event", pluginId: "demo", event: "changed", payload: 2 }) });
    expect(hosts[0]).toHaveBeenCalledTimes(1);
    expect(hosts[2]).toHaveBeenCalledTimes(2);

    unsubscribers[2]();
    expect(sources[0].close).toHaveBeenCalledTimes(1);

    const reopen = await subscribePluginEvents(vi.fn());
    expect(sources).toHaveLength(2);
    reopen();
  });
});
