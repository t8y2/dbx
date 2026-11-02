// @vitest-environment happy-dom
import { createApp, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";
import RedisQueryConsoleOutput from "@/components/redis/RedisQueryConsoleOutput.vue";
import { redisCommandResultToQueryResult } from "@/lib/redis/redisQueryResult";
import type { QueryResult } from "@/types/database";

const mounted: Array<{ unmount: () => void; host: HTMLElement }> = [];

afterEach(() => {
  for (const { unmount, host } of mounted.splice(0)) {
    unmount();
    host.remove();
  }
});

describe("RedisQueryConsoleOutput", () => {
  it("renders every command result and keeps failures visually distinct", async () => {
    const results: QueryResult[] = [
      { ...redisCommandResultToQueryResult("PONG", 1, "PING"), sourceStatement: "PING" },
      { ...redisCommandResultToQueryResult(["one", "two"], 1, "LRANGE items 0 -1"), sourceStatement: "LRANGE items 0 -1" },
      { columns: ["Error"], rows: [["ERR unknown command"]], affected_rows: 0, execution_time_ms: 0, execution_error: true, sourceStatement: "NOPE" },
    ];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ render: () => h(RedisQueryConsoleOutput, { results }) });
    app.use(createI18n({ legacy: false, locale: "en", messages: { en: { redis: { commandLine: "Command line", commandEmptyResult: "No output" } } } }));
    app.mount(host);
    mounted.push({ unmount: () => app.unmount(), host });
    await nextTick();

    expect([...host.querySelectorAll("div.flex.min-w-0")].map((node) => node.textContent?.trim())).toEqual(["redis>PING", "redis>LRANGE items 0 -1", "redis>NOPE"]);
    expect([...host.querySelectorAll("pre")].map((node) => node.textContent)).toEqual(["PONG", '1) "one"\n2) "two"', "(error) ERR unknown command"]);
    expect(host.querySelectorAll("pre")[2]?.className).toContain("text-[#ff6b6b]");
  });
});
