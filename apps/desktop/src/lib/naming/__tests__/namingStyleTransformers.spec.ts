// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { convertToNamingStyle } from "../namingStyleTransformers";

describe("namingStyleTransformers", () => {
  describe("convertToNamingStyle - camelCase", () => {
    it("converts snake_case to camelCase", () => {
      expect(convertToNamingStyle("user_name", "camelCase")).toBe("userName");
      expect(convertToNamingStyle("first_name_last", "camelCase")).toBe("firstNameLast");
    });

    it("converts PascalCase to camelCase", () => {
      expect(convertToNamingStyle("UserName", "camelCase")).toBe("userName");
      expect(convertToNamingStyle("FirstNameLast", "camelCase")).toBe("firstNameLast");
    });

    it("converts kebab-case to camelCase", () => {
      expect(convertToNamingStyle("user-name", "camelCase")).toBe("userName");
      expect(convertToNamingStyle("first-name-last", "camelCase")).toBe("firstNameLast");
    });

    it("converts SCREAMING_SNAKE_CASE to camelCase", () => {
      expect(convertToNamingStyle("USER_NAME", "camelCase")).toBe("userName");
      expect(convertToNamingStyle("FIRST_NAME_LAST", "camelCase")).toBe("firstNameLast");
    });
  });

  describe("convertToNamingStyle - PascalCase", () => {
    it("converts snake_case to PascalCase", () => {
      expect(convertToNamingStyle("user_name", "PascalCase")).toBe("UserName");
      expect(convertToNamingStyle("first_name_last", "PascalCase")).toBe("FirstNameLast");
    });

    it("converts camelCase to PascalCase", () => {
      expect(convertToNamingStyle("userName", "PascalCase")).toBe("UserName");
      expect(convertToNamingStyle("firstNameLast", "PascalCase")).toBe("FirstNameLast");
    });

    it("converts kebab-case to PascalCase", () => {
      expect(convertToNamingStyle("user-name", "PascalCase")).toBe("UserName");
      expect(convertToNamingStyle("first-name-last", "PascalCase")).toBe("FirstNameLast");
    });
  });

  describe("convertToNamingStyle - snake_case", () => {
    it("converts camelCase to snake_case", () => {
      expect(convertToNamingStyle("userName", "snake_case")).toBe("user_name");
      expect(convertToNamingStyle("firstNameLast", "snake_case")).toBe("first_name_last");
    });

    it("converts PascalCase to snake_case", () => {
      expect(convertToNamingStyle("UserName", "snake_case")).toBe("user_name");
      expect(convertToNamingStyle("FirstNameLast", "snake_case")).toBe("first_name_last");
    });

    it("converts kebab-case to snake_case", () => {
      expect(convertToNamingStyle("user-name", "snake_case")).toBe("user_name");
      expect(convertToNamingStyle("first-name-last", "snake_case")).toBe("first_name_last");
    });
  });

  describe("convertToNamingStyle - SCREAMING_SNAKE_CASE", () => {
    it("converts camelCase to SCREAMING_SNAKE_CASE", () => {
      expect(convertToNamingStyle("userName", "SCREAMING_SNAKE_CASE")).toBe("USER_NAME");
      expect(convertToNamingStyle("firstNameLast", "SCREAMING_SNAKE_CASE")).toBe("FIRST_NAME_LAST");
    });

    it("converts snake_case to SCREAMING_SNAKE_CASE", () => {
      expect(convertToNamingStyle("user_name", "SCREAMING_SNAKE_CASE")).toBe("USER_NAME");
      expect(convertToNamingStyle("first_name_last", "SCREAMING_SNAKE_CASE")).toBe("FIRST_NAME_LAST");
    });

    it("converts kebab-case to SCREAMING_SNAKE_CASE", () => {
      expect(convertToNamingStyle("user-name", "SCREAMING_SNAKE_CASE")).toBe("USER_NAME");
      expect(convertToNamingStyle("first-name-last", "SCREAMING_SNAKE_CASE")).toBe("FIRST_NAME_LAST");
    });
  });

  describe("convertToNamingStyle - kebab-case", () => {
    it("converts camelCase to kebab-case", () => {
      expect(convertToNamingStyle("userName", "kebab-case")).toBe("user-name");
      expect(convertToNamingStyle("firstNameLast", "kebab-case")).toBe("first-name-last");
    });

    it("converts snake_case to kebab-case", () => {
      expect(convertToNamingStyle("user_name", "kebab-case")).toBe("user-name");
      expect(convertToNamingStyle("first_name_last", "kebab-case")).toBe("first-name-last");
    });

    it("converts PascalCase to kebab-case", () => {
      expect(convertToNamingStyle("UserName", "kebab-case")).toBe("user-name");
      expect(convertToNamingStyle("FirstNameLast", "kebab-case")).toBe("first-name-last");
    });
  });

  describe("digit boundaries", () => {
    it("treats digit-to-letter transitions as word boundaries", () => {
      expect(convertToNamingStyle("user2Name", "PascalCase")).toBe("User2Name");
      expect(convertToNamingStyle("user2Name", "snake_case")).toBe("user2_name");
      expect(convertToNamingStyle("user2Name", "SCREAMING_SNAKE_CASE")).toBe("USER2_NAME");
      expect(convertToNamingStyle("user2Name", "kebab-case")).toBe("user2-name");
    });

    it("keeps digit runs attached to the preceding word", () => {
      expect(convertToNamingStyle("ipv4Address", "snake_case")).toBe("ipv4_address");
      expect(convertToNamingStyle("sha256Hash", "snake_case")).toBe("sha256_hash");
      expect(convertToNamingStyle("field1Value", "PascalCase")).toBe("Field1Value");
      expect(convertToNamingStyle("field1Value", "snake_case")).toBe("field1_value");
    });

    it("does not degrade mixed-case words through the cycle", () => {
      // The pre-fix bug: user2Name → PascalCase produced "User2name" and the
      // cycle collapsed into a two-state loop.
      expect(convertToNamingStyle("user2Name", "PascalCase")).not.toBe("User2name");
      expect(convertToNamingStyle("User2Name", "snake_case")).toBe("user2_name");
      expect(convertToNamingStyle("user2_name", "SCREAMING_SNAKE_CASE")).toBe("USER2_NAME");
      expect(convertToNamingStyle("USER2_NAME", "kebab-case")).toBe("user2-name");
      expect(convertToNamingStyle("user2-name", "camelCase")).toBe("user2Name");
    });

    it("handles identifiers that are all digits", () => {
      expect(convertToNamingStyle("123", "camelCase")).toBe("123");
      expect(convertToNamingStyle("123", "PascalCase")).toBe("123");
    });
  });

  describe("case preservation within words", () => {
    it("keeps mixed-case word bodies intact for camel/Pascal targets", () => {
      expect(convertToNamingStyle("user_name", "camelCase")).toBe("userName");
      expect(convertToNamingStyle("IP_address", "camelCase")).toBe("ipAddress");
    });

    it("lowercases tails only for all-uppercase words", () => {
      // SCREAMING words must fold (USER_NAME → userName), acronyms keep the
      // already-approved flattening behavior (HTTPServer → HttpServer).
      expect(convertToNamingStyle("USER_NAME", "camelCase")).toBe("userName");
      expect(convertToNamingStyle("HTTPServer", "PascalCase")).toBe("HttpServer");
    });
  });

  describe("leading and trailing separators", () => {
    it("preserves leading underscores", () => {
      expect(convertToNamingStyle("_privateField", "SCREAMING_SNAKE_CASE")).toBe("_PRIVATE_FIELD");
      expect(convertToNamingStyle("_privateField", "snake_case")).toBe("_private_field");
      expect(convertToNamingStyle("_privateField", "kebab-case")).toBe("_private-field");
      expect(convertToNamingStyle("_privateField", "PascalCase")).toBe("_PrivateField");
    });

    it("preserves repeated leading/trailing separator runs", () => {
      expect(convertToNamingStyle("__CONSTANT_NAME__", "camelCase")).toBe("__constantName__");
      expect(convertToNamingStyle("__CONSTANT_NAME__", "kebab-case")).toBe("__constant-name__");
    });

    it("preserves leading dollar signs", () => {
      expect(convertToNamingStyle("$scopeValue", "PascalCase")).toBe("$ScopeValue");
    });
  });

  describe("non-identifier input is left untouched", () => {
    it("returns original text when content is not a single identifier", () => {
      expect(convertToNamingStyle("price - discount", "camelCase")).toBe("price - discount");
      expect(convertToNamingStyle("-- fetch userName", "camelCase")).toBe("-- fetch userName");
      expect(convertToNamingStyle("a + b", "snake_case")).toBe("a + b");
    });

    it("returns original text for CJK and Cyrillic content", () => {
      expect(convertToNamingStyle("用户名", "camelCase")).toBe("用户名");
      expect(convertToNamingStyle("приветМир", "camelCase")).toBe("приветМир");
    });

    it("returns original text for multi-line content", () => {
      expect(convertToNamingStyle("userName\nlastName", "SCREAMING_SNAKE_CASE")).toBe("userName\nlastName");
    });

    it("returns original text for empty, whitespace, or separator-only input", () => {
      expect(convertToNamingStyle("", "camelCase")).toBe("");
      expect(convertToNamingStyle("   ", "camelCase")).toBe("   ");
      expect(convertToNamingStyle("___", "camelCase")).toBe("___");
    });
  });

  describe("whitespace preservation", () => {
    it("keeps leading and trailing whitespace around the converted core", () => {
      expect(convertToNamingStyle("  userName  ", "PascalCase")).toBe("  UserName  ");
      expect(convertToNamingStyle("\tuser_name\n", "camelCase")).toBe("\tuserName\n");
    });
  });

  describe("edge cases", () => {
    it("handles single words", () => {
      expect(convertToNamingStyle("user", "camelCase")).toBe("user");
      expect(convertToNamingStyle("user", "PascalCase")).toBe("User");
      expect(convertToNamingStyle("user", "snake_case")).toBe("user");
      expect(convertToNamingStyle("USER", "kebab-case")).toBe("user");
    });

    it("handles complex camelCase boundaries", () => {
      expect(convertToNamingStyle("userIDList", "snake_case")).toBe("user_id_list");
      expect(convertToNamingStyle("XMLParser", "kebab-case")).toBe("xml-parser");
      expect(convertToNamingStyle("parseHTTPResponse", "PascalCase")).toBe("ParseHttpResponse");
      expect(convertToNamingStyle("parseHTTPResponse", "snake_case")).toBe("parse_http_response");
    });
  });
});
