import { describe, expect, it } from "vitest";
import { redisCommandResultToQueryResult, redisQueryResultsToConsoleEntries } from "@/lib/redis/redisQueryResult";
import { formatRedisConsoleError, formatRedisConsoleValue } from "@/lib/redis/redisValuePresentation";
import type { QueryResult } from "@/types/database";

describe("formatRedisConsoleValue", () => {
  it("formats scalar, nil, integer, double, boolean and bulk-string replies", () => {
    expect(formatRedisConsoleValue(null)).toBe("(nil)");
    expect(formatRedisConsoleValue(42)).toBe("(integer) 42");
    expect(formatRedisConsoleValue(1.5)).toBe("(double) 1.5");
    expect(formatRedisConsoleValue(true)).toBe("(true)");
    expect(formatRedisConsoleValue("hello")).toBe("hello");
    expect(formatRedisConsoleValue("")).toBe('""');
  });

  it("numbers ordinary and nested arrays without collapsing nested values into JSON", () => {
    expect(formatRedisConsoleValue(["one", 2, null, ["nested", false]])).toBe(['1) "one"', "2) (integer) 2", "3) (nil)", '4) 1) "nested"', "   2) (false)"].join("\n"));
  });

  it("renders HGETALL, WITHSCORES and RESP3 map replies as readable pairs", () => {
    expect(formatRedisConsoleValue(["name", "alice", "age", "30"], "HGETALL profile")).toBe(['1) "name" => "alice"', '2) "age" => "30"'].join("\n"));
    expect(formatRedisConsoleValue(["alice", "1.5", "bob", "2"], "ZRANGE scores 0 -1 WITHSCORES")).toBe(['1) "alice" => "1.5"', '2) "bob" => "2"'].join("\n"));
    expect(
      formatRedisConsoleValue([
        { key: "name", value: "alice" },
        { key: "visits", value: 3 },
      ]),
    ).toBe(['1) "name" => "alice"', '2) "visits" => (integer) 3'].join("\n"));
  });

  it("keeps INFO text readable and prefixes errors once", () => {
    expect(formatRedisConsoleValue("# Server\nredis_version:7.4.2")).toBe("# Server\nredis_version:7.4.2");
    expect(formatRedisConsoleError("ERR wrong number of arguments")).toBe("(error) ERR wrong number of arguments");
    expect(formatRedisConsoleError("(error) already formatted")).toBe("(error) already formatted");
  });
});

describe("redisCommandResultToQueryResult", () => {
  it("keeps the existing scalar grid shape as the default while retaining console output", () => {
    const result = redisCommandResultToQueryResult(7, 4.6, "DBSIZE");
    expect(result).toMatchObject({
      columns: ["result"],
      rows: [["7"]],
      affected_rows: 0,
      execution_time_ms: 5,
      redis_console_output: "(integer) 7",
    });
  });

  it("pairs member/score rows for ZREVRANGE ... WITHSCORES instead of one row per array element", () => {
    const flat = ["carol", "300", "bob", "200", "alice", "100"];
    const result = redisCommandResultToQueryResult(flat, 5, "ZREVRANGE issue7229_repro:zset 0 -1 WITHSCORES");
    expect(result.columns).toEqual(["member", "score"]);
    expect(result.rows).toEqual([
      ["carol", "300"],
      ["bob", "200"],
      ["alice", "100"],
    ]);
    expect(result.affected_rows).toBe(3);
  });

  it("pairs member/score rows for ZRANGE ... WITHSCORES (lowercase modifier)", () => {
    const flat = ["alice", "1.5"];
    const result = redisCommandResultToQueryResult(flat, 5, "zrange myset 0 -1 withscores");
    expect(result.columns).toEqual(["member", "score"]);
    expect(result.rows).toEqual([["alice", "1.5"]]);
  });

  it("does not pair a plain ZRANGE result (no WITHSCORES modifier)", () => {
    const flat = ["alice", "bob"];
    const result = redisCommandResultToQueryResult(flat, 5, "ZRANGE myset 0 -1");
    expect(result.columns).toEqual(["(index)", "value"]);
    expect(result.rows).toEqual([
      [1, "alice"],
      [2, "bob"],
    ]);
  });

  it("still pairs field/value rows for HGETALL when given the full raw command text (not just the bare command head)", () => {
    const flat = ["name", "alice", "age", "30"];
    const result = redisCommandResultToQueryResult(flat, 5, "HGETALL myhash");
    expect(result.columns).toEqual(["field", "value"]);
    expect(result.rows).toEqual([
      ["name", "alice"],
      ["age", "30"],
    ]);
  });

  it("does not pair when a non-sorted-set command merely contains WITHSCORES in a key", () => {
    const flat = ["a", "b", "c"];
    const result = redisCommandResultToQueryResult(flat, 5, "LRANGE my:WITHSCORES:list 0 -1");
    expect(result.columns).toEqual(["(index)", "value"]);
    expect(result.rows).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]);
  });

  it("does not pair SMEMBERS when WITHSCORES appears as an argument", () => {
    const flat = ["x", "y"];
    const result = redisCommandResultToQueryResult(flat, 5, "SMEMBERS WITHSCORES");
    expect(result.columns).toEqual(["(index)", "value"]);
    expect(result.rows).toEqual([
      [1, "x"],
      [2, "y"],
    ]);
  });

  it("pairs member/score rows for ZRANGEBYSCORE ... WITHSCORES", () => {
    const flat = ["alice", "1", "bob", "2"];
    const result = redisCommandResultToQueryResult(flat, 5, "ZRANGEBYSCORE myzset -inf +inf WITHSCORES");
    expect(result.columns).toEqual(["member", "score"]);
    expect(result.rows).toEqual([
      ["alice", "1"],
      ["bob", "2"],
    ]);
  });

  it("builds ordered console entries for multiple commands and errors", () => {
    const first = { ...redisCommandResultToQueryResult("PONG", 1, "PING"), sourceStatement: "PING" };
    const second = { ...redisCommandResultToQueryResult(["a", "b"], 2, "LRANGE items 0 -1"), sourceStatement: "LRANGE items 0 -1" };
    const failed: QueryResult = {
      columns: ["Error"],
      rows: [["ERR invalid command"]],
      affected_rows: 0,
      execution_time_ms: 0,
      execution_error: true,
      sourceStatement: "BROKEN",
    };

    expect(redisQueryResultsToConsoleEntries([first, second, failed])).toEqual([
      { command: "PING", output: "PONG", error: false },
      { command: "LRANGE items 0 -1", output: ['1) "a"', '2) "b"'].join("\n"), error: false },
      { command: "BROKEN", output: "(error) ERR invalid command", error: true },
    ]);
  });
});
