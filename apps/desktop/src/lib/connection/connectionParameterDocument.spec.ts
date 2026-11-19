import { describe, expect, it } from "vitest";
import { LITERAL_PARAMETER_SYNTAX, QUERY_PARAMETER_SYNTAX, SQLSERVER_PARAMETER_SYNTAX, TERADATA_PARAMETER_SYNTAX, parameterIsSecret, parseConnectionParameters, writeConnectionParameters } from "./connectionParameterDocument";

describe("lossless connection parameter documents", () => {
  const legacyQuery = [
    "",
    "?",
    "?&",
    "&&",
    "  ",
    "charset=utf8mb4",
    "?charset=utf8mb4&&flag&empty=&",
    "localInfilePath=/tmp/a.csv&localInfilePath=C%3A%5Cdata%5Cb.csv",
    "CLIENT+CHARSET=AL32UTF8&DBX_LEGACY_CHARSET=ZHS16GBK",
    "application_name=DBX+app&options=-c%20search_path%3Dpublic%2Capp",
    "sessionVariables=sql_mode='STRICT,TRADITIONAL';@trace=concat('a,b','c')",
    "sessionVariables=group_concat_max_len%3D%40%40global.group_concat_max_len",
    "password=space+plus%2Bpercent%25equals%3Dand%26semi%3B&token=中文😀",
    "password=one=two=three&SSL=true&ssl=false&empty=&flag",
    "unknown=%ZZ&application_name=legacy&notUtf8=%FF&incomplete=%",
    "=orphan& key = value &%20=emptyKey&literalSemi=a;b;c",
    "credentials=/tmp/key.json&authSource=admin&retryWrites=false",
  ];
  it.each(legacyQuery)("preserves existing query bytes: %s", (source) => {
    const document = parseConnectionParameters(source);
    expect(writeConnectionParameters(document, document.entries)).toEqual({ value: source, errors: [] });
  });
  it.each([
    "encrypt=true;trustServerCertificate=false",
    ";applicationName=DBX;password={a;b&c=d}}e};extra=",
    "?a=one&password={x;two&three}}four};unknown=100%+",
    "password={unterminated;applicationName=must-not-split",
    "password= {brace;with&separators};applicationName=DBX",
    "a=1;;flag;&b=two&&",
    "password={};a=1",
    "password={}}};a=1",
  ])("preserves SQL Server brace escaping and mixed separators: %s", (source) => {
    const document = parseConnectionParameters(source, SQLSERVER_PARAMETER_SYNTAX);
    expect(writeConnectionParameters(document, document.entries)).toEqual({ value: source, errors: [] });
  });
  it("edits only the selected duplicate, preserving spelling, ordering and encoding of everything else", () => {
    const source = "?localInfilePath=%2ftmp%2fa.csv&localInfilePath=/tmp/b.csv&&unknown=%ZZ&flag&x=a+b&";
    const document = parseConnectionParameters(source);
    document.entries[1].value = "/tmp/中文 & +.csv";
    expect(writeConnectionParameters(document, document.entries)).toEqual({ value: "?localInfilePath=%2ftmp%2fa.csv&localInfilePath=%2Ftmp%2F%E4%B8%AD%E6%96%87%20%26%20%2B.csv&&unknown=%ZZ&flag&x=a+b&", errors: [] });
  });
  it("does not split nested session-variable statements at semicolons or equal signs", () => {
    const source = "sessionVariables=sql_mode='A,B';@trace=concat('x;y','=','z')&time_zone=%2B08%3A00";
    const document = parseConnectionParameters(source);
    expect(document.entries).toHaveLength(2);
    expect(document.entries[0].value).toBe("sql_mode='A,B';@trace=concat('x;y','=','z')");
    document.entries[1].value = "+09:00";
    expect(writeConnectionParameters(document, document.entries).value).toBe(source.replace("%2B08%3A00", "%2B09%3A00"));
  });
  it("round trips decoded plus signs, delimiters, Unicode and empty values after editing", () => {
    const document = parseConnectionParameters("flag&empty=&x=before");
    document.entries[2].value = "中文😀 + % & ; = # ? ";
    const written = writeConnectionParameters(document, document.entries);
    expect(written.errors).toEqual([]);
    expect(parseConnectionParameters(written.value).entries[2].value).toBe(document.entries[2].value);
    expect(written.value).toMatch(/^flag&empty=&x=/);
  });
  it("distinguishes unset, bare flag, and explicitly empty values", () => {
    const document = parseConnectionParameters("flag&empty=&x=1");
    expect(document.entries.map((e) => e.hasEquals)).toEqual([false, true, true]);
    document.entries[0].hasEquals = true;
    expect(writeConnectionParameters(document, document.entries).value).toBe("flag=&empty=&x=1");
    expect(writeConnectionParameters(document, document.entries.slice(2)).value).toBe("x=1");
    expect(writeConnectionParameters(document, []).value).toBe("");
  });
  it("appends entries without normalizing unrelated trailing separators or unknown keys", () => {
    const document = parseConnectionParameters("?x=%2f&&flag&");
    const next = [...document.entries, { id: "new", key: "CLIENT CHARSET", value: "UTF-8", hasEquals: true, editable: true }];
    expect(writeConnectionParameters(document, next).value).toBe("?x=%2f&&flag&CLIENT%20CHARSET=UTF-8");
  });
  it("encodes SQL Server braces without applying URL decoding to literal plus and percent", () => {
    const document = parseConnectionParameters("password={a;b&c=d}}e};applicationName=100%+DBX", SQLSERVER_PARAMETER_SYNTAX);
    expect(document.entries.map((e) => e.value)).toEqual(["a;b&c=d}e", "100%+DBX"]);
    document.entries[0].value = "x}y;z&next=one";
    const written = writeConnectionParameters(document, document.entries);
    expect(written.value).toBe("password={x}}y;z&next=one};applicationName=100%+DBX");
    expect(parseConnectionParameters(written.value, SQLSERVER_PARAMETER_SYNTAX).entries[0].value).toBe(document.entries[0].value);
  });
  it("preserves literal semicolon properties, including plus and percent", () => {
    const document = parseConnectionParameters("CLIENT_LOCALE=en_US.utf8;path=C:\\data\\100%+;unknown=@value", LITERAL_PARAMETER_SYNTAX);
    document.entries[0].value = "zh_CN.GB18030";
    expect(writeConnectionParameters(document, document.entries).value).toBe("CLIENT_LOCALE=zh_CN.GB18030;path=C:\\data\\100%+;unknown=@value");
  });
  it("does not invent escaping rules for a literal driver", () => {
    const document = parseConnectionParameters("x=legacy", LITERAL_PARAMETER_SYNTAX);
    document.entries[0].value = "one;two";
    expect(writeConnectionParameters(document, document.entries)).toEqual({ value: document.source, errors: [{ entryId: document.entries[0].id, reason: "literal-delimiter" }] });
  });
  it("retains malformed parameters while permitting unrelated edits, and rejects rewriting opaque values", () => {
    const document = parseConnectionParameters("invalid=%FF&app=old");
    expect(document.issues).toHaveLength(1);
    document.entries[1].value = "new";
    expect(writeConnectionParameters(document, document.entries).value).toBe("invalid=%FF&app=new");
    document.entries[0].value = "changed";
    expect(writeConnectionParameters(document, document.entries).errors[0].reason).toBe("opaque");
  });
  it("reports unclosed braces without fragmenting a password", () => {
    const document = parseConnectionParameters("password={one;two&three", SQLSERVER_PARAMETER_SYNTAX);
    expect(document.entries).toHaveLength(1);
    expect(document.issues[0].reason).toBe("braces");
  });
  it("rejects empty keys, duplicate row identities and non-encodable edits", () => {
    const document = parseConnectionParameters("x=one");
    expect(writeConnectionParameters(document, [...document.entries, document.entries[0]]).errors[0].reason).toBe("duplicate-id");
    document.entries[0].key = " ";
    expect(writeConnectionParameters(document, document.entries).errors[0].reason).toBe("key");
    document.entries[0].key = "x";
    document.entries[0].value = "\ud800";
    expect(writeConnectionParameters(document, document.entries).errors[0].reason).toBe("encoding");
  });
  it("quotes Teradata delimiters in values and rejects delimiters in new names", () => {
    const document = parseConnectionParameters("LOGDATA='a,b; x''y'&CHARSET=UTF8", TERADATA_PARAMETER_SYNTAX);
    expect(document.entries.map((entry) => entry.value)).toEqual(["a,b; x'y", "UTF8"]);
    document.entries[0].value = "new, value; with&delimiters";
    const written = writeConnectionParameters(document, document.entries);
    expect(written.errors).toEqual([]);
    expect(parseConnectionParameters(written.value, TERADATA_PARAMETER_SYNTAX).entries[0].value).toBe(document.entries[0].value);
    document.entries[0].key = "bad,name";
    expect(writeConnectionParameters(document, document.entries).errors[0].reason).toBe("literal-delimiter");
  });
  it("preserves arbitrary existing bytes for all supported grammars", () => {
    let state = 0x12345678;
    const chars = "a=&;%+?{}#'\" \n中文😀";
    for (const syntax of [QUERY_PARAMETER_SYNTAX, SQLSERVER_PARAMETER_SYNTAX, LITERAL_PARAMETER_SYNTAX]) {
      for (let run = 0; run < 500; run++) {
        let source = "";
        for (let index = 0; index < run % 90; index++) {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          source += chars[state % chars.length];
        }
        const document = parseConnectionParameters(source, syntax);
        expect(writeConnectionParameters(document, document.entries), JSON.stringify({ source, syntax })).toEqual({ value: source, errors: [] });
      }
    }
  });
  it.each(["password", "SSLPassword", "PWD", "accessToken", "api_secret", "OAuthPvtKey", "privateKey", "credentials"])("redacts sensitive parameter names: %s", (key) => {
    expect(parameterIsSecret(key)).toBe(true);
  });
});
