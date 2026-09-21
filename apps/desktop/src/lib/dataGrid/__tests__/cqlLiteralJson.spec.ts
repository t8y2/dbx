import { describe, expect, it } from "vitest";
import { cqlLiteralToJsonText } from "../cqlLiteralJson";

describe("cqlLiteralToJsonText", () => {
  it("converts map literals into JSON objects", () => {
    expect(cqlLiteralToJsonText("{'color': 'blue', 'region': 'eu-west', 'tier': 'gold'}")).toBe('{"color":"blue","region":"eu-west","tier":"gold"}');
    expect(cqlLiteralToJsonText("{10: false, 2: true}")).toBe('{"10":false,"2":true}');
    expect(cqlLiteralToJsonText("{}")).toBe("{}");
  });

  it("converts list, set and tuple literals into JSON arrays", () => {
    expect(cqlLiteralToJsonText("['a', 'b']")).toBe('["a","b"]');
    expect(cqlLiteralToJsonText("{'a', 'b'}")).toBe('["a","b"]');
    expect(cqlLiteralToJsonText("(1, 'a', null)")).toBe('[1,"a",null]');
    expect(cqlLiteralToJsonText("[]")).toBe("[]");
  });

  it("keeps CQL escapes, separators inside strings and non-text scalars", () => {
    expect(cqlLiteralToJsonText("['it''s', 'x,y', 'z=1', 'a: \"b\"']")).toBe('["it\'s","x,y","z=1","a: \\"b\\""]');
    expect(cqlLiteralToJsonText("[00112233-4455-6677-8899-aabbccddeeff, '10.0.0.1', 0x01, 1mo2d3ns, 1.5, -2, 12345678901234567890]")).toBe('["00112233-4455-6677-8899-aabbccddeeff","10.0.0.1","0x01","1mo2d3ns",1.5,-2,12345678901234567890]');
  });

  it("recurses into nested collections", () => {
    expect(cqlLiteralToJsonText("{'count': 3, 'tags': ['x', 'y'], 'pos': (1, 2), 'meta': {'k': {'n': null}}}")).toBe('{"count":3,"tags":["x","y"],"pos":[1,2],"meta":{"k":{"n":null}}}');
  });

  it("rejects text that is not a CQL collection literal", () => {
    expect(cqlLiteralToJsonText("plain text")).toBeUndefined();
    expect(cqlLiteralToJsonText("{'a': 1")).toBeUndefined();
    expect(cqlLiteralToJsonText("{'a': 1} trailing")).toBeUndefined();
    expect(cqlLiteralToJsonText("['unterminated]")).toBeUndefined();
    expect(cqlLiteralToJsonText("{'a' 1}")).toBeUndefined();
    expect(cqlLiteralToJsonText("[1,, 2]")).toBeUndefined();
  });
});
