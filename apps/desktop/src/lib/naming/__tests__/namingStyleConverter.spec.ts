// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { convertToNextNamingStyle } from "../namingStyleConverter";

describe("namingStyleConverter", () => {
  describe("convertToNextNamingStyle", () => {
    it("cycles through all naming styles", () => {
      // Start with camelCase
      let result = convertToNextNamingStyle("userName");
      expect(result.text).toBe("UserName");
      expect(result.style).toBe("PascalCase");

      // PascalCase → snake_case
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("user_name");
      expect(result.style).toBe("snake_case");

      // snake_case → SCREAMING_SNAKE_CASE
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("USER_NAME");
      expect(result.style).toBe("SCREAMING_SNAKE_CASE");

      // SCREAMING_SNAKE_CASE → kebab-case
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("user-name");
      expect(result.style).toBe("kebab-case");

      // kebab-case → camelCase (cycle back)
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("userName");
      expect(result.style).toBe("camelCase");
    });

    it("handles multi-word identifiers", () => {
      let result = convertToNextNamingStyle("userNameList");
      expect(result.text).toBe("UserNameList");

      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("user_name_list");

      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("USER_NAME_LIST");

      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("user-name-list");

      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("userNameList");
    });

    it("keeps a full five-state cycle for identifiers containing digits", () => {
      let result = convertToNextNamingStyle("user2Name");
      expect(result.text).toBe("User2Name");
      expect(result.style).toBe("PascalCase");

      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("user2_name");
      expect(result.style).toBe("snake_case");

      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("USER2_NAME");
      expect(result.style).toBe("SCREAMING_SNAKE_CASE");

      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("user2-name");
      expect(result.style).toBe("kebab-case");

      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("user2Name");
      expect(result.style).toBe("camelCase");
    });

    it("cycles common digit-bearing identifiers without collapsing", () => {
      for (const identifier of ["ipv4Address", "field1Value", "sha256Hash"]) {
        const seen = new Set<string>();
        let current = identifier;
        for (let hop = 0; hop < 5; hop += 1) {
          current = convertToNextNamingStyle(current).text;
          seen.add(current);
        }
        // Five hops must land back on the original text and pass through four
        // distinct intermediate forms (the set holds all five results, the
        // last of which is the original identifier again).
        expect(current).toBe(identifier);
        expect(seen.size).toBe(5);
      }
    });

    it("preserves leading underscores through the cycle", () => {
      let result = convertToNextNamingStyle("_privateField");
      expect(result.text).toBe("_PRIVATE_FIELD");
      expect(result.style).toBe("SCREAMING_SNAKE_CASE");

      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("_private-field");
      expect(result.style).toBe("kebab-case");

      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("_privateField");
      expect(result.style).toBe("camelCase");
    });

    it("respects explicit currentStyle parameter", () => {
      const result = convertToNextNamingStyle("test", "snake_case");
      expect(result.text).toBe("TEST");
      expect(result.style).toBe("SCREAMING_SNAKE_CASE");
    });

    it("returns text unchanged for empty or non-identifier input", () => {
      expect(convertToNextNamingStyle("").text).toBe("");
      expect(convertToNextNamingStyle("   ").text).toBe("   ");
      expect(convertToNextNamingStyle("123").text).toBe("123");
    });

    it("returns text unchanged for selections that are not a single identifier", () => {
      expect(convertToNextNamingStyle("price - discount").text).toBe("price - discount");
      expect(convertToNextNamingStyle("-- fetch userName").text).toBe("-- fetch userName");
      expect(convertToNextNamingStyle("用户名").text).toBe("用户名");
      expect(convertToNextNamingStyle("userName\nlastName").text).toBe("userName\nlastName");
    });

    it("preserves leading/trailing whitespace around the converted core", () => {
      const result = convertToNextNamingStyle("  userName  ");
      expect(result.text).toBe("  UserName  ");
      expect(result.style).toBe("PascalCase");
    });

    it("handles single-word identifiers (with ambiguity)", () => {
      // Single lowercase words are ambiguous (could be camelCase, snake_case, or kebab-case)
      // The cycle still works but may skip some styles
      let result = convertToNextNamingStyle("user");
      expect(result.text).toBe("User"); // camelCase → PascalCase
      expect(result.style).toBe("PascalCase");

      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("user"); // PascalCase → snake_case
      expect(result.style).toBe("snake_case");

      // Note: "user" looks like camelCase to the detector, so it cycles back to PascalCase
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("User"); // detected as camelCase → PascalCase
      expect(result.style).toBe("PascalCase");

      // For proper cycling, use a multi-word identifier
      let multiWord = convertToNextNamingStyle("userName");
      expect(multiWord.text).toBe("UserName");
      multiWord = convertToNextNamingStyle(multiWord.text);
      expect(multiWord.text).toBe("user_name");
      multiWord = convertToNextNamingStyle(multiWord.text);
      expect(multiWord.text).toBe("USER_NAME");
      multiWord = convertToNextNamingStyle(multiWord.text);
      expect(multiWord.text).toBe("user-name");
      multiWord = convertToNextNamingStyle(multiWord.text);
      expect(multiWord.text).toBe("userName"); // Full cycle complete
    });
  });
});
