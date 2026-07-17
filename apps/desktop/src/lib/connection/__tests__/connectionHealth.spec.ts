import { describe, expect, it } from "vitest";
import { shouldMarkDisconnected } from "@/lib/connection/connectionHealth";

describe("connectionHealth", () => {
  it("marks localized and JDBC communication errors as disconnected", () => {
    expect(shouldMarkDisconnected("Agent RPC error (-1): dm.jdbc.driver.DMException: 网络通信异常")).toBe(true);
    expect(shouldMarkDisconnected("Agent RPC error (-1): com.mysql.cj.jdbc.exceptions.CommunicationsException: Communications link failure")).toBe(true);
    expect(shouldMarkDisconnected("Agent RPC error (-1): java.sql.SQLRecoverableException: IO 错误: Got minus one from a read call")).toBe(true);
  });

  it("does not mark ordinary SQL or authentication errors as disconnected", () => {
    expect(shouldMarkDisconnected("syntax error at or near SELECT")).toBe(false);
    expect(shouldMarkDisconnected("Access denied for user root")).toBe(false);
  });
});
