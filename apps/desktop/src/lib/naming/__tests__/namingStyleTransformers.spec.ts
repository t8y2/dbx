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

  describe("edge cases", () => {
    it("handles single words", () => {
      expect(convertToNamingStyle("user", "camelCase")).toBe("user");
      expect(convertToNamingStyle("user", "PascalCase")).toBe("User");
      expect(convertToNamingStyle("user", "snake_case")).toBe("user");
      expect(convertToNamingStyle("USER", "kebab-case")).toBe("user");
    });

    it("returns original text for empty or non-identifier input", () => {
      expect(convertToNamingStyle("", "camelCase")).toBe("");
      expect(convertToNamingStyle("   ", "camelCase")).toBe("   ");
      expect(convertToNamingStyle("123", "camelCase")).toBe("123");
    });

    it("handles complex camelCase boundaries", () => {
      expect(convertToNamingStyle("userIDList", "snake_case")).toBe("user_id_list");
      expect(convertToNamingStyle("XMLParser", "kebab-case")).toBe("xml-parser");
    });
  });
});
