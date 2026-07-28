import { describe, it, expect } from "vitest";
import { buildHoverTableSql, hoverTableMatchesScope, reformatHoverDdl, sanitizeHoverDdl, scopeHoverTables } from "@/lib/editor/hoverTableSql";
import type { ColumnInfo, IndexInfo } from "@/types/database";

type ColumnOverride = Partial<ColumnInfo> & { name: string; data_type: string };
type IndexOverride = Partial<IndexInfo> & { name: string };

function col(overrides: ColumnOverride): ColumnInfo {
  return {
    name: overrides.name,
    data_type: overrides.data_type,
    is_nullable: true,
    is_primary_key: false,
    column_default: null,
    extra: null,
    comment: null,
    character_maximum_length: null,
    numeric_precision: null,
    numeric_scale: null,
    ...overrides,
  };
}

function idx(overrides: IndexOverride): IndexInfo {
  return {
    name: overrides.name,
    columns: [],
    is_unique: false,
    is_primary: false,
    ...overrides,
  };
}

describe("buildHoverTableSql", () => {
  it("single column, no PK, no indexes", () => {
    const sql = buildHoverTableSql('"mydb"."public"."users"', [col({ name: "email", data_type: "text", is_nullable: false })], []);
    expect(sql).toMatchInlineSnapshot(`
      "create table "mydb"."public"."users" (
          "email" text not null
      );"
    `);
  });

  it("single column with PK", () => {
    const sql = buildHoverTableSql('"mydb"."public"."users"', [col({ name: "id", data_type: "integer", is_nullable: false, is_primary_key: true })], [idx({ name: "pk_users", is_primary: true, columns: ["id"] })]);
    expect(sql).toMatchInlineSnapshot(`
      "create table "mydb"."public"."users" (
          "id" integer not null,
        primary key ("id")
      );"
    `);
  });

  it("composite primary key", () => {
    const sql = buildHoverTableSql(
      '"public"."order_items"',
      [col({ name: "order_id", data_type: "bigint", is_nullable: false }), col({ name: "line_item", data_type: "integer", is_nullable: false }), col({ name: "sku", data_type: "varchar(50)" })],
      [idx({ name: "pk_order_items", is_primary: true, columns: ["order_id", "line_item"] })],
    );
    // The PRIMARY KEY table constraint is on a separate line, joined by comma.
    // No comma on the last column — the join handles it.
    expect(sql).toMatchInlineSnapshot(`
      "create table "public"."order_items" (
          "order_id"  bigint      not null,
          "line_item" integer     not null,
          "sku"       varchar(50) null,
        primary key ("order_id", "line_item")
      );"
    `);
  });

  it("no primary key (multi-column)", () => {
    const sql = buildHoverTableSql('"public"."audit_log"', [col({ name: "event", data_type: "text", is_nullable: false }), col({ name: "created_at", data_type: "timestamptz", column_default: "now()" })], []);
    expect(sql).toMatchInlineSnapshot(`
      "create table "public"."audit_log" (
          "event"      text                      not null,
          "created_at" timestamptz default now() null
      );"
    `);
  });

  it("SQL Server varchar(max) and datetime2(7) — trust backend data_type", () => {
    const sql = buildHoverTableSql(
      '"dbo"."orders"',
      [col({ name: "notes", data_type: "varchar(max)", is_nullable: true }), col({ name: "created_at", data_type: "datetime2(7)", column_default: "getdate()" }), col({ name: "status", data_type: "varchar(20)", is_nullable: false })],
      [idx({ name: "ix_orders_created", is_primary: false, columns: ["created_at"] })],
    );
    expect(sql).toMatchInlineSnapshot(`
      "create table "dbo"."orders" (
          "notes"      varchar(max)                   null,
          "created_at" datetime2(7) default getdate() null,
          "status"     varchar(20)                    not null
      );

      create index "ix_orders_created"
        on "dbo"."orders" ("created_at");"
    `);
  });

  it("trusts backend parameterized data_type over decomposed fields", () => {
    // Even though character_maximum_length is set, the backend's data_type
    // already contains (255), so we must trust it and NOT append again.
    const sql = buildHoverTableSql('"public"."t"', [col({ name: "name", data_type: "character varying(255)", character_maximum_length: 255 })], []);
    expect(sql).toContain("character varying(255)");
    expect(sql).not.toContain("character varying(255)(255)");
  });

  it("SQL Server (max) from character_maximum_length=-1", () => {
    const sql = buildHoverTableSql('"dbo"."t"', [col({ name: "payload", data_type: "nvarchar", character_maximum_length: -1 })], []);
    expect(sql).toContain("nvarchar(max)");
  });

  it("includes table comment", () => {
    const sql = buildHoverTableSql('"public"."users"', [col({ name: "id", data_type: "serial", is_nullable: false })], [idx({ name: "pk_users", is_primary: true, columns: ["id"] })], "User accounts");
    expect(sql).toMatchInlineSnapshot(`
      "create table "public"."users" (
          "id" serial not null,
        primary key ("id")
      ) comment 'User accounts';"
    `);
  });

  it("extra column attributes (auto_increment)", () => {
    const sql = buildHoverTableSql('"public"."t"', [col({ name: "id", data_type: "int", is_nullable: false, extra: "auto_increment" })], [idx({ name: "pk_t", is_primary: true, columns: ["id"] })]);
    expect(sql).toContain("auto_increment");
  });

  it("non-primary indexes are emitted after DDL", () => {
    const sql = buildHoverTableSql('"public"."t"', [col({ name: "a", data_type: "int" }), col({ name: "b", data_type: "int" }), col({ name: "c", data_type: "int" })], [idx({ name: "ix_t_b", columns: ["b"] }), idx({ name: "ix_t_c", is_unique: true, columns: ["c"] })]);
    expect(sql).toMatchInlineSnapshot(`
      "create table "public"."t" (
          "a" int  null,
          "b" int  null,
          "c" int  null
      );

      create index "ix_t_b"
        on "public"."t" ("b");
      create unique index "ix_t_c"
        on "public"."t" ("c");"
    `);
  });

  it("empty columns produces minimal DDL", () => {
    const sql = buildHoverTableSql('"t"', [], []);
    expect(sql).toBe('create table "t" (\n\n);');
  });

  describe("sanitizeHoverDdl", () => {
    it("removes column-level CHARACTER SET and COLLATE from MySQL DDL", () => {
      const input = `CREATE TABLE \`users\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`email\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  \`name\` varchar(100) CHARACTER SET utf8mb4 NOT NULL,
  \`bio\` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
      expect(sanitizeHoverDdl(input)).toBe(`CREATE TABLE \`users\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`email\` varchar(255) NOT NULL,
  \`name\` varchar(100) NOT NULL,
  \`bio\` text,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB`);
    });

    it("removes table-level CHARSET and COLLATE", () => {
      const input = "CREATE TABLE t (id int) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
      expect(sanitizeHoverDdl(input)).toBe("CREATE TABLE t (id int) ENGINE=InnoDB");
    });

    it("removes standalone table-level CHARACTER SET", () => {
      const input = "CREATE TABLE t (id int) CHARACTER SET utf8 ENGINE=InnoDB";
      expect(sanitizeHoverDdl(input)).toBe("CREATE TABLE t (id int) ENGINE=InnoDB");
    });

    it("does not alter DDL without charset/COLLATE clauses", () => {
      const input = `CREATE TABLE "orders" (
  "id" bigint NOT NULL,
  "total" numeric(10,2),
  PRIMARY KEY ("id")
);`;
      expect(sanitizeHoverDdl(input)).toBe(input);
    });

    it("removes COLLATE without preceding CHARACTER SET on column", () => {
      const input = "CREATE TABLE t (name varchar(255) COLLATE utf8mb4_bin NOT NULL);";
      expect(sanitizeHoverDdl(input)).toBe("CREATE TABLE t (name varchar(255) NOT NULL);");
    });

    it("handles MariaDB table-level CHARACTER SET syntax", () => {
      const input = `CREATE TABLE t (id int) ENGINE=InnoDB DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci`;
      expect(sanitizeHoverDdl(input)).toBe("CREATE TABLE t (id int) ENGINE=InnoDB");
    });
  });

  it("column-level PK fallback when no primary index is present", () => {
    const sql = buildHoverTableSql('"public"."t"', [col({ name: "id", data_type: "int", is_nullable: false, is_primary_key: true }), col({ name: "label", data_type: "text" })], []);
    expect(sql).toMatchInlineSnapshot(`
      "create table "public"."t" (
          "id"    int  not null,
          "label" text null,
        primary key ("id")
      );"
    `);
  });
});

describe("reformatHoverDdl", () => {
  it("preserves sanitized raw MySQL DDL when table options are present", () => {
    const raw = `CREATE TABLE \`users\` (
  \`id\` int(11) unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  \`email\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'Email',
  \`bio\` text CHARACTER SET utf8mb4,
  \`created_at\` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`ux_users_email\` (\`email\`),
  KEY \`ix_users_created\` (\`created_at\` DESC)
) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户表'`;
    expect(reformatHoverDdl(raw)).toBe(sanitizeHoverDdl(raw));
  });

  it("preserves Postgres companion statements verbatim", () => {
    const raw = `CREATE TABLE "public"."orders" (
  "id" bigint NOT NULL DEFAULT nextval('orders_id_seq'::regclass),
  "total" numeric(10,2),
  "note" character varying(255),
  PRIMARY KEY ("id")
);
COMMENT ON TABLE "public"."orders" IS 'Order headers';
COMMENT ON COLUMN "public"."orders"."total" IS 'Amount';
CREATE INDEX "ix_orders_total" ON "public"."orders" ("total");`;
    expect(reformatHoverDdl(raw)).toBe(raw);
  });

  it("preserves PostgreSQL index USING, INCLUDE, and WHERE clauses", () => {
    const raw = `CREATE TABLE "public"."orders" (
  "id" bigint NOT NULL,
  "email" text,
  "deleted_at" timestamptz
);
CREATE INDEX "ix_orders_email" ON "public"."orders" USING btree ("email") INCLUDE ("id") WHERE "deleted_at" IS NULL;`;
    expect(reformatHoverDdl(raw)).toBe(raw);
  });

  it("preserves partition and distribution table clauses", () => {
    const raw = `CREATE TABLE analytics.events (
  event_date date NOT NULL,
  tenant_id bigint NOT NULL
) PARTITION BY RANGE (event_date)
DISTRIBUTED BY HASH (tenant_id);`;
    expect(reformatHoverDdl(raw)).toBe(raw);
  });

  it("uses the provided qualified name override for the table and indexes", () => {
    const raw = "CREATE TABLE `t` (`a` int NOT NULL, KEY `ix_a` (`a`))";
    const sql = reformatHoverDdl(raw, '"mydb"."t"');
    expect(sql).toContain('create table "mydb"."t" (');
    expect(sql).toContain('on "mydb"."t" ("a");');
  });

  it("preserves foreign key and check constraints verbatim", () => {
    const raw = `CREATE TABLE t (
  id int NOT NULL,
  parent_id int,
  CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES t (id),
  CHECK (id > 0)
)`;
    const sql = reformatHoverDdl(raw);
    expect(sql).toContain("CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES t (id)");
    expect(sql).toContain("CHECK (id > 0)");
  });

  it("keeps defaults containing commas inside parentheses intact", () => {
    const raw = "CREATE TABLE t (a numeric(10,2) DEFAULT round(1.234, 2) NOT NULL, b int)";
    const sql = reformatHoverDdl(raw);
    expect(sql).toContain("default round(1.234, 2)");
    expect(sql).toContain("numeric(10,2)");
  });

  it("falls back to sanitized raw DDL when the statement is not CREATE TABLE", () => {
    const raw = "CREATE VIEW v AS SELECT 1 ENGINE=x DEFAULT CHARSET=utf8mb4";
    expect(reformatHoverDdl(raw)).toBe("CREATE VIEW v AS SELECT 1 ENGINE=x");
  });

  it("passes through unrecognized companion statements", () => {
    const raw = `CREATE TABLE t (a int);\nALTER TABLE t OWNER TO app;`;
    expect(reformatHoverDdl(raw)).toBe(raw);
  });
});

describe("hover table scope", () => {
  it("annotates loaded tables with their catalog, database, and schema", () => {
    expect(scopeHoverTables([{ name: "orders" }], { catalog: "hive", database: "sales", schema: "public" })).toEqual([{ name: "orders", catalog: "hive", database: "sales", schema: "public" }]);
  });

  it("rejects a bare-name cache hit from another database or schema", () => {
    const target = { catalog: "hive", database: "sales", schema: "public" };
    expect(hoverTableMatchesScope({ name: "orders", catalog: "hive", database: "archive", schema: "public" }, target)).toBe(false);
    expect(hoverTableMatchesScope({ name: "orders", catalog: "hive", database: "sales", schema: "audit" }, target)).toBe(false);
    expect(hoverTableMatchesScope({ name: "orders", catalog: "iceberg", database: "sales", schema: "public" }, target)).toBe(false);
    expect(hoverTableMatchesScope({ name: "orders", catalog: "hive", database: "sales", schema: "public" }, target)).toBe(true);
  });

  it("does not trust an unscoped cached table", () => {
    expect(hoverTableMatchesScope({ name: "orders" }, { database: "sales", schema: "public" })).toBe(false);
  });
});
