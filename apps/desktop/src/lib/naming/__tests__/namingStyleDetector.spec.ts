// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { detectNamingStyle } from "../namingStyleDetector";

describe("namingStyleDetector", () => {
  it("detects camelCase", () => {
    expect(detectNamingStyle("userName")).toBe("camelCase");
    expect(detectNamingStyle("firstName")).toBe("camelCase");
    expect(detectNamingStyle("userNameList")).toBe("camelCase");
  });

  it("detects PascalCase", () => {
    expect(detectNamingStyle("UserName")).toBe("PascalCase");
    expect(detectNamingStyle("FirstName")).toBe("PascalCase");
    expect(detectNamingStyle("UserNameList")).toBe("PascalCase");
  });

  it("detects snake_case", () => {
    expect(detectNamingStyle("user_name")).toBe("snake_case");
    expect(detectNamingStyle("first_name")).toBe("snake_case");
    expect(detectNamingStyle("user_name_list")).toBe("snake_case");
  });

  it("detects SCREAMING_SNAKE_CASE", () => {
    expect(detectNamingStyle("USER_NAME")).toBe("SCREAMING_SNAKE_CASE");
    expect(detectNamingStyle("FIRST_NAME")).toBe("SCREAMING_SNAKE_CASE");
    expect(detectNamingStyle("USER_NAME_LIST")).toBe("SCREAMING_SNAKE_CASE");
  });

  it("detects kebab-case", () => {
    expect(detectNamingStyle("user-name")).toBe("kebab-case");
    expect(detectNamingStyle("first-name")).toBe("kebab-case");
    expect(detectNamingStyle("user-name-list")).toBe("kebab-case");
  });

  it("returns null for empty or non-identifier text", () => {
    expect(detectNamingStyle("")).toBeNull();
    expect(detectNamingStyle("   ")).toBeNull();
    expect(detectNamingStyle("123")).toBeNull();
    expect(detectNamingStyle("___")).toBeNull();
  });

  it("handles mixed styles by priority", () => {
    // Hyphen has highest priority
    expect(detectNamingStyle("user-name_test")).toBe("kebab-case");
    // Underscore + uppercase = SCREAMING_SNAKE_CASE
    expect(detectNamingStyle("USER_NAME")).toBe("SCREAMING_SNAKE_CASE");
    // Underscore + not all uppercase = snake_case
    expect(detectNamingStyle("User_Name")).toBe("snake_case");
  });
});
