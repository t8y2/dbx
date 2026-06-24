import { describe, expect, it } from "vitest";
import { formatZooKeeperMetadataRows, formatZooKeeperSummaryBadges, prettyPrintJsonText } from "@/lib/kvValueDisplay";
import type { KvKeyMetadata } from "@/lib/api";

describe("kv value display helpers", () => {
  it("pretty prints valid JSON text", () => {
    expect(prettyPrintJsonText('{"name":"张三","roles":["admin","reader"]}')).toEqual({
      ok: true,
      value: '{\n  "name": "张三",\n  "roles": [\n    "admin",\n    "reader"\n  ]\n}',
    });
  });

  it("does not treat plain text as JSON", () => {
    expect(prettyPrintJsonText("hello")).toEqual({
      ok: false,
      error: "invalid_json",
    });
  });

  it("formats ZooKeeper summary badges with ZK fallbacks", () => {
    const metadata: KvKeyMetadata = {
      mzxid: 29,
      version: 0,
      lease: null,
      dataLength: 291,
    };

    expect(formatZooKeeperSummaryBadges(metadata)).toEqual([
      { label: "rev", value: "29" },
      { label: "ver", value: "0" },
      { label: "lease", value: "-" },
      { label: "size", value: "291 B" },
    ]);
  });

  it("formats ZooKeeper summary badges with localized labels", () => {
    const metadata: KvKeyMetadata = {
      mzxid: 373437,
      version: 0,
      lease: null,
      dataLength: 291,
    };

    expect(
      formatZooKeeperSummaryBadges(metadata, {
        revision: "修订",
        version: "版本",
        lease: "租约",
        size: "大小",
      }),
    ).toEqual([
      { label: "修订", value: "373437" },
      { label: "版本", value: "0" },
      { label: "租约", value: "-" },
      { label: "大小", value: "291 B" },
    ]);
  });

  it("formats ZooKeeper stat rows using user-facing labels", () => {
    const metadata: KvKeyMetadata = {
      ephemeralOwner: 0,
      ctime: 1780674584000,
      mtime: 1780674585000,
      mzxid: 27,
      pzxid: 39825,
      czxid: 27,
      dataLength: 0,
      numChildren: 5,
      version: 0,
      aversion: 0,
      cversion: 5,
    };

    expect(formatZooKeeperMetadataRows(metadata).map((row) => [row.label, row.value])).toEqual([
      ["ephemeralOwner", "0x0"],
      ["mtime", expect.stringMatching(/^2026-06-05 \d{2}:49:45$/)],
      ["ctime", expect.stringMatching(/^2026-06-05 \d{2}:49:44$/)],
      ["mZxid", "0x1b"],
      ["pZxid", "0x9b91"],
      ["cZxid", "0x1b"],
      ["dataLength", "0"],
      ["numChildren", "5"],
      ["dataVersion", "0"],
      ["aclVersion", "0"],
      ["cVersion", "5"],
    ]);
  });
});
