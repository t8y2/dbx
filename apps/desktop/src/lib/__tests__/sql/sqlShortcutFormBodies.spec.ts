import { describe, expect, it } from "vitest";
import { applySqlShortcutBodyToAllSelected, buildSqlShortcutBodiesForSave, clearSqlShortcutFormDatabaseTypes, flushSqlShortcutEditingBody, switchSqlShortcutEditingDatabaseType, toggleSqlShortcutFormDatabaseType, type SqlShortcutFormBodies } from "@/lib/sql/sqlShortcutFormBodies";

function form(overrides: Partial<SqlShortcutFormBodies> = {}): SqlShortcutFormBodies {
  return {
    sql: "SELECT * FROM ${table} /* default */",
    body: "SELECT * FROM ${table} /* default */",
    databaseTypes: [],
    sqlByDatabaseType: {},
    editingDatabaseType: "",
    ...overrides,
  };
}

describe("sqlShortcutFormBodies", () => {
  it("flushes scoped edits into the override map without changing default sql", () => {
    const next = flushSqlShortcutEditingBody(
      form({
        databaseTypes: ["mysql", "postgres"],
        editingDatabaseType: "mysql",
        body: "SELECT 1 FROM ${table} /* mysql */",
      }),
    );
    expect(next.sql).toBe("SELECT * FROM ${table} /* default */");
    expect(next.sqlByDatabaseType.mysql).toBe("SELECT 1 FROM ${table} /* mysql */");
  });

  it("switches database by flushing current and loading override or default sql", () => {
    const afterMysql = flushSqlShortcutEditingBody(
      form({
        databaseTypes: ["mysql", "postgres"],
        editingDatabaseType: "mysql",
        body: "SELECT 1 FROM ${table} /* mysql */",
      }),
    );
    const afterPostgres = switchSqlShortcutEditingDatabaseType(afterMysql, "postgres");
    expect(afterPostgres.sqlByDatabaseType.mysql).toBe("SELECT 1 FROM ${table} /* mysql */");
    expect(afterPostgres.body).toBe("SELECT * FROM ${table} /* default */");
    expect(afterPostgres.sql).toBe("SELECT * FROM ${table} /* default */");
  });

  it("does not fill unedited databases on save", () => {
    const edited = flushSqlShortcutEditingBody(
      form({
        databaseTypes: ["mysql", "postgres"],
        editingDatabaseType: "mysql",
        body: "SELECT 1 FROM ${table} /* mysql */",
      }),
    );
    const saved = buildSqlShortcutBodiesForSave(edited);
    expect(saved.sql).toBe("SELECT * FROM ${table} /* default */");
    expect(saved.databaseTypes).toEqual(["mysql", "postgres"]);
    expect(saved.sqlByDatabaseType).toEqual({ mysql: "SELECT 1 FROM ${table} /* mysql */" });
  });

  it("removes override when unchecking a database and does not pollute default sql", () => {
    const start = form({
      databaseTypes: ["mysql", "postgres"],
      editingDatabaseType: "mysql",
      body: "SELECT 1 FROM ${table} /* mysql */",
      sqlByDatabaseType: {
        mysql: "SELECT 1 FROM ${table} /* mysql */",
        postgres: "SELECT 2 FROM ${table} /* postgres */",
      },
    });
    const afterUncheck = toggleSqlShortcutFormDatabaseType(start, "mysql");
    expect(afterUncheck.databaseTypes).toEqual(["postgres"]);
    expect(afterUncheck.sqlByDatabaseType.mysql).toBeUndefined();
    expect(afterUncheck.sqlByDatabaseType.postgres).toBe("SELECT 2 FROM ${table} /* postgres */");
    expect(afterUncheck.sql).toBe("SELECT * FROM ${table} /* default */");
    expect(afterUncheck.editingDatabaseType).toBe("postgres");
    expect(afterUncheck.body).toBe("SELECT 2 FROM ${table} /* postgres */");
  });

  it("clears all overrides when returning to all databases", () => {
    const start = form({
      databaseTypes: ["mysql", "postgres"],
      editingDatabaseType: "postgres",
      body: "SELECT 2 FROM ${table} /* postgres */",
      sqlByDatabaseType: {
        mysql: "SELECT 1 FROM ${table} /* mysql */",
        postgres: "SELECT 2 FROM ${table} /* postgres */",
      },
    });
    const cleared = clearSqlShortcutFormDatabaseTypes(start);
    expect(cleared.databaseTypes).toEqual([]);
    expect(cleared.sqlByDatabaseType).toEqual({});
    expect(cleared.editingDatabaseType).toBe("");
    expect(cleared.sql).toBe("SELECT 2 FROM ${table} /* postgres */");
    expect(cleared.body).toBe("SELECT 2 FROM ${table} /* postgres */");
  });

  it("does not revive overrides when re-checking a database", () => {
    const afterRemove = toggleSqlShortcutFormDatabaseType(
      form({
        databaseTypes: ["mysql"],
        editingDatabaseType: "mysql",
        body: "SELECT 1 FROM ${table} /* mysql */",
        sqlByDatabaseType: { mysql: "SELECT 1 FROM ${table} /* mysql */" },
      }),
      "mysql",
    );
    expect(afterRemove.databaseTypes).toEqual([]);
    expect(afterRemove.sqlByDatabaseType).toEqual({});
    const reAdd = toggleSqlShortcutFormDatabaseType(afterRemove, "mysql");
    expect(reAdd.databaseTypes).toEqual(["mysql"]);
    expect(reAdd.sqlByDatabaseType.mysql).toBeUndefined();
    expect(reAdd.body).toBe(afterRemove.sql);
  });

  it("applies current body to all selected databases and default sql", () => {
    const applied = applySqlShortcutBodyToAllSelected(
      form({
        databaseTypes: ["mysql", "postgres"],
        editingDatabaseType: "mysql",
        body: "SELECT 9 FROM ${table}",
        sqlByDatabaseType: { mysql: "SELECT 1 FROM ${table}" },
      }),
    );
    expect(applied.sql).toBe("SELECT 9 FROM ${table}");
    expect(applied.sqlByDatabaseType).toEqual({
      mysql: "SELECT 9 FROM ${table}",
      postgres: "SELECT 9 FROM ${table}",
    });
  });
});
