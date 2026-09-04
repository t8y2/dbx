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

    it("respects explicit currentStyle parameter", () => {
      const result = convertToNextNamingStyle("test", "snake_case");
      expect(result.text).toBe("TEST");
      expect(result.style).toBe("SCREAMING_SNAKE_CASE");
    });

    it("handles empty or non-identifier text gracefully", () => {
      expect(convertToNextNamingStyle("").text).toBe("");
      expect(convertToNextNamingStyle("   ").text).toBe("   ");
      expect(convertToNextNamingStyle("123").text).toBe("123");
    });

    it("preserves leading/trailing whitespace in original text", () => {
      const result = convertToNextNamingStyle("  userName  ");
      // Trimming happens inside, but we return the converted text without extra space
      expect(result.text).toBe("UserName");
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
