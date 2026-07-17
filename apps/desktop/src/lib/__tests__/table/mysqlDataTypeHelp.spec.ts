import { describe, expect, it } from "vitest";
import { DATA_TYPE_OPTIONS } from "@/lib/table/tableStructureEditorState";
import { getMysqlDataTypeHelp } from "@/lib/table/mysqlDataTypeHelp";
import en from "@/i18n/locales/en";
import zhCN from "@/i18n/locales/zh-CN";

function mysqlHelpMessages(locale: unknown): Record<string, unknown> {
  const messages = locale as { structureEditor?: { mysqlDataTypeHelp?: Record<string, unknown> } };
  return messages.structureEditor?.mysqlDataTypeHelp ?? {};
}

describe("getMysqlDataTypeHelp", () => {
  it("normalizes MySQL attributes, aliases, parameters, casing, and whitespace", () => {
    expect(getMysqlDataTypeHelp(" INT(11) UNSIGNED ")).toEqual({ key: "int", warningKeys: ["integerDisplayWidth"] });
    expect(getMysqlDataTypeHelp("integer zerofill")).toEqual({ key: "int", warningKeys: ["zerofill"] });
    expect(getMysqlDataTypeHelp("NUMERIC(10, 2)")).toEqual({ key: "decimal" });
    expect(getMysqlDataTypeHelp(" double   precision ")).toEqual({ key: "double" });
    expect(getMysqlDataTypeHelp("BOOL")).toEqual({ key: "boolean" });
    expect(getMysqlDataTypeHelp("DEC(20, 6)")).toEqual({ key: "decimal" });
    expect(getMysqlDataTypeHelp("CHARACTER VARYING(120)")).toEqual({ key: "varchar" });
    expect(getMysqlDataTypeHelp("CHARACTER(12)")).toEqual({ key: "char" });
    expect(getMysqlDataTypeHelp("CHAR VARYING(120)")).toEqual({ key: "varchar" });
    expect(getMysqlDataTypeHelp("CHAR BYTE")).toEqual({ key: "char" });
  });

  it("covers phpMyAdmin's additional MySQL type aliases for dynamic type lists", () => {
    expect(getMysqlDataTypeHelp("FIXED")?.key).toBe("decimal");
    expect(getMysqlDataTypeHelp("FLOAT4")?.key).toBe("float");
    expect(getMysqlDataTypeHelp("FLOAT8")?.key).toBe("double");
    expect(getMysqlDataTypeHelp("INT1")?.key).toBe("tinyint");
    expect(getMysqlDataTypeHelp("INT2")?.key).toBe("smallint");
    expect(getMysqlDataTypeHelp("INT3")?.key).toBe("mediumint");
    expect(getMysqlDataTypeHelp("INT4")?.key).toBe("int");
    expect(getMysqlDataTypeHelp("INT8")?.key).toBe("bigint");
    expect(getMysqlDataTypeHelp("MIDDLEINT")?.key).toBe("mediumint");
    expect(getMysqlDataTypeHelp("LONG")?.key).toBe("mediumtext");
    expect(getMysqlDataTypeHelp("LONG VARCHAR")?.key).toBe("mediumtext");
    expect(getMysqlDataTypeHelp("LONG VARBINARY")?.key).toBe("mediumblob");
    expect(getMysqlDataTypeHelp("GEOMCOLLECTION")?.key).toBe("geometrycollection");
    expect(getMysqlDataTypeHelp("NCHAR(30)")?.key).toBe("nationalCharacter");
    expect(getMysqlDataTypeHelp("NVARCHAR(30)")?.key).toBe("nationalCharacter");
    expect(getMysqlDataTypeHelp("NATIONAL CHARACTER VARYING(30)")?.key).toBe("nationalCharacter");
  });

  it("documents numeric, text, binary, enum, temporal, JSON, and spatial types", () => {
    expect(getMysqlDataTypeHelp("bigint unsigned")?.key).toBe("bigint");
    expect(getMysqlDataTypeHelp("varchar")?.key).toBe("varchar");
    expect(getMysqlDataTypeHelp("mediumblob")?.key).toBe("mediumblob");
    expect(getMysqlDataTypeHelp("enum")?.key).toBe("enum");
    expect(getMysqlDataTypeHelp("timestamp")?.key).toBe("timestamp");
    expect(getMysqlDataTypeHelp("json")?.key).toBe("json");
    expect(getMysqlDataTypeHelp("geometrycollection")?.key).toBe("geometrycollection");
  });

  it("uses product-specific JSON help when the connection profile identifies the server", () => {
    expect(getMysqlDataTypeHelp("json")).toEqual({ key: "json" });
    expect(getMysqlDataTypeHelp("json", { product: "mysql" })).toEqual({ key: "jsonMysql" });
    expect(getMysqlDataTypeHelp("json", { product: "mariadb" })).toEqual({ key: "jsonMariaDb" });
  });

  it("warns about MySQL 8 numeric syntax based on the exact raw type", () => {
    expect(getMysqlDataTypeHelp("INT(11) ZEROFILL")).toEqual({ key: "int", warningKeys: ["integerDisplayWidth", "zerofill"] });
    expect(getMysqlDataTypeHelp("DECIMAL(10,2) UNSIGNED")).toEqual({ key: "decimal", warningKeys: ["unsignedNumeric"] });
    expect(getMysqlDataTypeHelp("FLOAT(30)")).toEqual({ key: "float", warningKeys: ["floatPrecision"] });
    expect(getMysqlDataTypeHelp("DOUBLE(10,2) UNSIGNED")).toEqual({ key: "double", warningKeys: ["unsignedNumeric", "floatingPointDisplay"] });
  });

  it("also recognizes compatible-server extensions and leaves unknown custom types alone", () => {
    expect(getMysqlDataTypeHelp("inet4")?.key).toBe("inet4");
    expect(getMysqlDataTypeHelp("inet6")?.key).toBe("inet6");
    expect(getMysqlDataTypeHelp("uuid")?.key).toBe("uuid");
    expect(getMysqlDataTypeHelp("vector(1536)")?.key).toBe("vector");
    expect(getMysqlDataTypeHelp("xmltype")?.key).toBe("xmltype");
    expect(getMysqlDataTypeHelp("my_private_type")).toBeUndefined();
  });

  it("covers every built-in MySQL type option", () => {
    const undocumented = DATA_TYPE_OPTIONS.mysql.filter((type) => !getMysqlDataTypeHelp(type));
    expect(undocumented).toEqual([]);
  });

  it("has an English and Simplified Chinese message for every supported help key", () => {
    const options = [...DATA_TYPE_OPTIONS.mysql, "inet4", "inet6", "uuid", "vector", "xmltype", "character", "char varying", "char byte", "geomcollection", "nchar", "nvarchar", "national character varying", "int(11) zerofill", "decimal(10,2) unsigned", "float(30)", "double(10,2)"];
    const english = mysqlHelpMessages(en);
    const chinese = mysqlHelpMessages(zhCN);

    for (const option of options) {
      const key = getMysqlDataTypeHelp(option)?.key;
      expect(key, option).toBeTruthy();
      for (const helpKey of [key!, ...(getMysqlDataTypeHelp(option)?.warningKeys ?? [])]) {
        expect(english[helpKey], `English: ${option}`).toEqual(expect.any(String));
        expect(chinese[helpKey], `Simplified Chinese: ${option}`).toEqual(expect.any(String));
      }
    }
  });
});
