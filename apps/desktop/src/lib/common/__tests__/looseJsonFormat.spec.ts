import { describe, expect, it } from "vitest";

import { formatLooseJsonText } from "@/lib/common/looseJsonFormat";

describe("formatLooseJsonText", () => {
  it("indents Fastjson WriteClassName output without changing any token (issue #14384)", () => {
    const source = '[{"@type":"com.example.SysDictData","createTime":"2023-08-05 11:54:37","default":true,"dictCode":1L,"dictSort":-2S,"ratio":1.5F,"tags":Set["a","b"],"ids":TreeSet[],"params":{"@type":"java.util.HashMap"}}]';

    expect(formatLooseJsonText(source)).toBe(
      [
        "[",
        "  {",
        '    "@type": "com.example.SysDictData",',
        '    "createTime": "2023-08-05 11:54:37",',
        '    "default": true,',
        '    "dictCode": 1L,',
        '    "dictSort": -2S,',
        '    "ratio": 1.5F,',
        '    "tags": Set[',
        '      "a",',
        '      "b"',
        "    ],",
        '    "ids": TreeSet[],',
        '    "params": {',
        '      "@type": "java.util.HashMap"',
        "    }",
        "  }",
        "]",
      ].join("\n"),
    );
  });

  it.each([
    ["brackets and separators inside strings", '{"text":"a, b: [c] {d}","n":1L}', ["{", '  "text": "a, b: [c] {d}",', '  "n": 1L', "}"]],
    ["escaped quotes inside strings", '{"q":"say \\"hi\\", ok","n":1L}', ["{", '  "q": "say \\"hi\\", ok",', '  "n": 1L', "}"]],
    ["whitespace inside strings", '{ "s" : "  two  spaces  " , "n" : 1L }', ["{", '  "s": "  two  spaces  ",', '  "n": 1L', "}"]],
    ["an escaped backslash before a closing quote", '{"p":"C:\\\\","n":1L}', ["{", '  "p": "C:\\\\",', '  "n": 1L', "}"]],
    ["a trailing comma", '{"n":1L,}', ["{", '  "n": 1L,', "}"]],
    ["already indented text", '{\n    "n": 1L,\n    "m": [ ]\n}', ["{", '  "n": 1L,', '  "m": []', "}"]],
  ])("keeps %s intact", (_, source, expected) => {
    expect(formatLooseJsonText(source)).toBe(expected.join("\n"));
  });

  it("uses the requested indent width", () => {
    expect(formatLooseJsonText("[1L]", 4)).toBe("[\n    1L\n]");
  });

  it.each([
    ["plain text", "hello"],
    ["text that only starts with a brace", "{name} joined {team}"],
    ["an object whose first key is unquoted", "{name: 1L}"],
    ["a bracketed log prefix", "[INFO] started]"],
    ["a truncated value", '[{"dictCode":1L},{"dictCode":2L'],
    ["an unterminated string", '{"a":"b}'],
    ["mismatched brackets", '{"a":[1L}]'],
    ["two top-level containers", '{"a":1L}{"b":2L}'],
    ["an empty string", "   "],
  ])("returns null for %s", (_, source) => {
    expect(formatLooseJsonText(source)).toBeNull();
  });
});
