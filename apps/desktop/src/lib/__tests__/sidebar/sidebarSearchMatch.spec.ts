import { describe, expect, it } from "vitest";
import { matchSidebarLabel } from "@/lib/sidebar/sidebarSearch";

describe("sidebar label matching ladder", () => {
  it.each([
    ["orders", "orders", "exact"],
    ["orders_2024", "ORD", "prefix"],
    ["sys_orders", "ord", "word-prefix"],
    ["camelCaseTable", "case", "word-prefix"],
    ["customer_orders", "omer", "substring"],
    ["system_exception_log", "sel", "abbreviation"],
    ["del_order", "delo", "word-prefix"],
    ["system_exception_log", "exclog", "abbreviation"],
    ["T_Erp_Nc_SuPlan_List", "erpncs", "substring"],
  ] as const)("%s matches %s as %s", (label, query, kind) => {
    expect(matchSidebarLabel(label, query)?.kind).toBe(kind);
  });

  it("rejects labels that do not contain the query characters in order", () => {
    expect(matchSidebarLabel("customer_orders", "zzq")).toBeNull();
    expect(matchSidebarLabel("orders", "sredro")).toBeNull();
    expect(matchSidebarLabel("ab", "abc")).toBeNull();
  });

  it("keeps matching non-ASCII queries and labels", () => {
    expect(matchSidebarLabel("Über_Tabelle", "über")?.kind).toBe("prefix");
    expect(matchSidebarLabel("用户_订单", "订单")?.kind).toBe("word-prefix");
    expect(matchSidebarLabel("Σίσυφος_Table", "σίσ")?.kind).toBe("prefix");
  });

  it("honours the stricter modes", () => {
    expect(matchSidebarLabel("customer_orders", "omer", { matchMode: "contains" })?.kind).toBe("substring");
    expect(matchSidebarLabel("customer_orders", "orders", { matchMode: "edges" })?.kind).toBe("suffix");
    expect(matchSidebarLabel("customer_orders", "omer", { matchMode: "edges" })).toBeNull();
    expect(matchSidebarLabel("del_order", "delo", { matchMode: "contains" })).toBeNull();
  });

  it("applies regex queries to the original label", () => {
    expect(matchSidebarLabel("Order_2024", "^Order_\\d+$", { regexMode: true })?.kind).toBe("regex");
    expect(matchSidebarLabel("my_Order_2024", "^Order_\\d+$", { regexMode: true })).toBeNull();
  });
});
