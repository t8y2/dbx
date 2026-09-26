import { describe, expect, it, vi } from "vitest";
import { buildPluginAiRequest, createPluginAiConversation, pluginContextFromMessages, streamPluginAiConversation } from "../aiPluginConversation";
import type { AiConfig } from "@/types/ai";
import type { AgentEvent } from "@/lib/backend/tauri";

const identity = { id: "market", name: "Market Watch" };
const input = () => ({ title: "AAPL", prompt: "Analyse risks", context: { quotes: [{ symbol: "AAPL", price: 100, currency: "USD" }], snapshotId: "snap-1" } });

describe("plugin conversations in DBX AI", () => {
  it("binds the host identity and freezes a data snapshot without auto-sending by default", () => {
    const request = input();
    const opened = createPluginAiConversation(identity, { ...request, pluginId: "other-plugin", pluginName: "spoof" });
    request.context.quotes[0].price = 999;
    expect(opened.send).toBe(false);
    expect(opened.context).toMatchObject({ pluginId: "market", pluginName: "Market Watch", data: { quotes: [{ price: 100 }] } });
    expect(opened).not.toHaveProperty("apiKey");
  });

  it.each([{ title: "" }, { prompt: "" }, { context: [] }, { send: "true" }, { context: { callback: () => {} } }, { context: { big: "x".repeat(2 * 1024 * 1024) } }])("rejects malformed or oversized requests", (override) => {
    expect(() => createPluginAiConversation(identity, { ...input(), ...override })).toThrow();
  });

  it("retains the snapshot in restored messages and passes it to follow-ups with the transcript", () => {
    const opened = createPluginAiConversation(identity, input());
    const transcript = JSON.parse(
      JSON.stringify([
        { role: "user", content: "Analyse risks", pluginContext: opened.context },
        { role: "assistant", content: "The supplied price is 100 USD." },
        { role: "user", content: "What is missing?" },
      ]),
    );
    const context = pluginContextFromMessages(transcript)!;
    const request = buildPluginAiRequest(
      { model: "test-model" } as AiConfig,
      context,
      transcript.map(({ role, content }: { role: "user" | "assistant"; content: string }) => ({ role, content })),
    );
    expect(request.messages[0].content).toContain('"price": 100');
    expect(request.messages[0].content).toContain("snap-1");
    expect(request.messages.slice(1).map((message) => message.content)).toEqual(transcript.map((message: { content: string }) => message.content));
    expect(request.taskContract).toEqual({ action: "plugin", mode: "ask", userRequest: "What is missing?" });
    expect(request).not.toHaveProperty("connectionId");
    expect(request.systemPrompt).toContain("no database, filesystem or trading tools");
  });

  it("uses the AI panel event pipeline and waits for stream completion before reporting success", async () => {
    const events: AgentEvent[] = [];
    let complete!: () => void;
    const backendDone = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const request = buildPluginAiRequest({ model: "test" } as AiConfig, createPluginAiConversation(identity, input()).context, []);
    const stream = vi.fn(async (sessionId, _request, onChunk) => {
      onChunk({ session_id: sessionId, reasoning_delta: "checking", delta: "", done: false });
      onChunk({ session_id: sessionId, delta: "reply", done: true });
      await backendDone;
    });
    const pending = streamPluginAiConversation(stream, "owned-session", request, (event) => events.push(event));
    expect(events).toEqual([
      { type: "reasoning_delta", delta: "checking" },
      { type: "text_delta", delta: "reply" },
    ]);
    complete();
    await pending;
    expect(events[2]).toEqual({ type: "agent_end" });
    expect(stream).toHaveBeenCalledWith("owned-session", request, expect.any(Function));
  });

  it("rejects a disconnected stream without a terminal event", async () => {
    const onEvent = vi.fn();
    const request = buildPluginAiRequest({} as AiConfig, createPluginAiConversation(identity, input()).context, []);
    await expect(
      streamPluginAiConversation(
        async (_id, _request, onChunk) => {
          onChunk({ session_id: "s", delta: "partial", done: false });
        },
        "s",
        request,
        onEvent,
      ),
    ).rejects.toThrow("AI stream ended before completion");
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: "text_delta", delta: "partial" });
  });

  it("does not turn a failed stream into a successful assistant message", async () => {
    const onEvent = vi.fn();
    const request = buildPluginAiRequest({} as AiConfig, createPluginAiConversation(identity, input()).context, []);
    await expect(streamPluginAiConversation(vi.fn().mockRejectedValue(new Error("provider unavailable")), "s", request, onEvent)).rejects.toThrow("provider unavailable");
    expect(onEvent).not.toHaveBeenCalled();
  });
});
