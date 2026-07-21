import { describe, expect, it } from "vitest";
import { appendCreateDatabaseErrorHint } from "@/lib/database/createDatabaseErrorHints";

const hint = "Use an account with GRANT OPTION to grant CREATE permission.";
const t = (key: string) => (key === "contextMenu.mysqlCreateDatabasePermissionHint" ? hint : key);

describe("appendCreateDatabaseErrorHint", () => {
  it("adds guidance for MySQL error 1044", () => {
    const message = appendCreateDatabaseErrorHint("mysql", "ERROR 1044 (42000): Access denied for user 'root'@'%' to database 'pro'", t);

    expect(message).toContain("ERROR 1044");
    expect(message).toContain(hint);
  });

  it("recognizes access-denied messages when the driver omits the error code", () => {
    const message = appendCreateDatabaseErrorHint("mysql", "Access denied for user 'app'@'%' to database 'pro'", t);

    expect(message).toContain(hint);
  });

  it("does not alter unrelated or non-MySQL errors", () => {
    expect(appendCreateDatabaseErrorHint("mysql", "ERROR 1007: Can't create database; database exists", t)).toBe("ERROR 1007: Can't create database; database exists");
    expect(appendCreateDatabaseErrorHint("postgres", "ERROR 1044: permission denied", t)).toBe("ERROR 1044: permission denied");
  });

  it("does not append the same hint twice", () => {
    const original = `ERROR 1044: Access denied\n\n${hint}`;

    expect(appendCreateDatabaseErrorHint("mysql", original, t)).toBe(original);
  });
});
