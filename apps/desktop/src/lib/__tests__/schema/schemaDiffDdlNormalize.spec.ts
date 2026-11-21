import { describe, expect, it } from "vitest";
import { inferSchemaFromSql, stripSchemaFromSql } from "@/lib/schema/schemaDiffDdlNormalize";
import { buildHunks } from "@/components/diff/DiffHunkBuilder";

describe("schemaDiffDdlNormalize", () => {
  describe("inferSchemaFromSql", () => {
    it("infers quoted double-quote schema from CREATE TABLE", () => {
      expect(inferSchemaFromSql('CREATE TABLE "public"."users" ("id" int);')).toBe("public");
    });

    it("infers bracketed schema from CREATE TABLE", () => {
      expect(inferSchemaFromSql("CREATE TABLE [dbo].[users] ([id] int);")).toBe("dbo");
    });

    it("infers backtick schema from CREATE TABLE", () => {
      expect(inferSchemaFromSql("CREATE TABLE `mydb`.`users` (`id` int);")).toBe("mydb");
    });

    it("infers unquoted schema from CREATE TABLE", () => {
      expect(inferSchemaFromSql("CREATE TABLE public.users (id int);")).toBe("public");
    });

    it("infers schema from ALTER TABLE", () => {
      expect(inferSchemaFromSql('ALTER TABLE ONLY "my_schema"."orders" ADD CONSTRAINT "fk" ...;')).toBe("my_schema");
    });

    it("infers schema from CREATE VIEW", () => {
      expect(inferSchemaFromSql('CREATE OR REPLACE VIEW "analytics"."sales" AS SELECT 1;')).toBe("analytics");
    });

    it("infers schema from MySQL CREATE ALGORITHM/DEFINER VIEW", () => {
      expect(inferSchemaFromSql("CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `mydb`.`v` AS SELECT 1;")).toBe("mydb");
    });

    it("infers schema from MySQL ALTER VIEW", () => {
      expect(inferSchemaFromSql("ALTER ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `mydb`.`v` AS SELECT 1;")).toBe("mydb");
    });

    it("returns null when table has no schema prefix", () => {
      expect(inferSchemaFromSql('CREATE TABLE "users" ("id" int);')).toBeNull();
    });
  });

  describe("stripSchemaFromSql", () => {
    it("strips double-quoted PostgreSQL schema from table, index, comments and foreign keys", () => {
      const sql = `CREATE TABLE "public"."users" (
  "id" integer NOT NULL,
  "name" text NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
COMMENT ON TABLE "public"."users" IS 'user accounts in public.schema';
COMMENT ON COLUMN "public"."users"."name" IS 'user display name';
CREATE INDEX "users_name_idx" ON "public"."users" USING btree ("name");
ALTER TABLE ONLY "public"."orders" ADD CONSTRAINT "fk_user" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id");
`;

      const result = stripSchemaFromSql(sql, "public");

      expect(result).toBe(`CREATE TABLE "users" (
  "id" integer NOT NULL,
  "name" text NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
COMMENT ON TABLE "users" IS 'user accounts in public.schema';
COMMENT ON COLUMN "users"."name" IS 'user display name';
CREATE INDEX "users_name_idx" ON "users" USING btree ("name");
ALTER TABLE ONLY "orders" ADD CONSTRAINT "fk_user" FOREIGN KEY ("user_id") REFERENCES "users"("id");
`);
    });

    it("strips bracketed SQL Server schema prefix", () => {
      const sql = "CREATE TABLE [dbo].[users] ([id] int NOT NULL);";
      expect(stripSchemaFromSql(sql, "dbo")).toBe("CREATE TABLE [users] ([id] int NOT NULL);");
    });

    it("strips backtick MySQL database/schema prefix", () => {
      const sql = "CREATE TABLE `db_name`.`users` (`id` int NOT NULL);";
      expect(stripSchemaFromSql(sql, "db_name")).toBe("CREATE TABLE `users` (`id` int NOT NULL);");
    });

    it("strips inferred schema from a MySQL ALGORITHM/DEFINER view", () => {
      const sql = "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `mydb`.`active_users` AS SELECT * FROM `mydb`.`users`;";
      expect(stripSchemaFromSql(sql)).toBe("CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `active_users` AS SELECT * FROM `users`;");
    });

    it("keeps backslash-escaped quotes in MySQL string literals when stripping", () => {
      const sql = "CREATE TABLE `db`.`t` (`id` int COMMENT 'user\\'s db.notes');";
      expect(stripSchemaFromSql(sql, "db")).toBe("CREATE TABLE `t` (`id` int COMMENT 'user\\'s db.notes');");
    });

    it("keeps escaped-quote literals distinct so unequal comments still differ", () => {
      const source = "CREATE TABLE `db`.`t` (`id` int COMMENT 'user\\'s db.notes');";
      const target = "CREATE TABLE `db`.`t` (`id` int COMMENT 'user\\'s db.other');";
      expect(stripSchemaFromSql(source, "db")).not.toBe(stripSchemaFromSql(target, "db"));
    });

    it("does not start a string literal at an apostrophe inside a quoted identifier", () => {
      const sql = `CREATE TABLE "public"."it's" ("id" int);`;
      expect(stripSchemaFromSql(sql, "public")).toBe(`CREATE TABLE "it's" ("id" int);`);
    });

    it("protects string literals inside array literals", () => {
      const sql = "CREATE TABLE public.users (tags text[] DEFAULT ARRAY['public.a','public.b']);";
      expect(stripSchemaFromSql(sql, "public")).toBe("CREATE TABLE users (tags text[] DEFAULT ARRAY['public.a','public.b']);");
    });

    it("strips unquoted schema prefix without touching string literals", () => {
      const sql = `CREATE TABLE public.users (
  id integer NOT NULL,
  status text DEFAULT 'public.active'
);`;
      const result = stripSchemaFromSql(sql, "public");
      expect(result).toBe(`CREATE TABLE users (
  id integer NOT NULL,
  status text DEFAULT 'public.active'
);`);
    });

    it("strips unquoted schema prefix without lookbehind syntax", () => {
      // Regression: the unquoted strip must not use lookbehind syntax (old
      // WebKit cannot parse it); a `.` before the name blocks the strip, so
      // dot-qualified second segments are preserved.
      expect(stripSchemaFromSql("CREATE TABLE public.users (id int);", "public")).toBe("CREATE TABLE users (id int);");
      expect(stripSchemaFromSql("CREATE TABLE public.public.users (id int);", "public")).toBe("CREATE TABLE public.users (id int);");
      expect(stripSchemaFromSql("SELECT * FROM x.public.users;", "public")).toBe("SELECT * FROM x.public.users;");
    });

    it("preserves comments and dollar-quoted functions", () => {
      const sql = `-- comment with public.users
/* block comment with public.users */
CREATE FUNCTION public.calc() RETURNS void AS $func$
  SELECT * FROM public.users;
$func$ LANGUAGE plpgsql;`;
      const result = stripSchemaFromSql(sql, "public");
      expect(result).toContain("-- comment with public.users");
      expect(result).toContain("/* block comment with public.users */");
      expect(result).toContain("CREATE FUNCTION calc()");
      expect(result).toContain("SELECT * FROM public.users;");
    });

    it("infers schema automatically when schema argument is omitted", () => {
      const sql = 'CREATE TABLE "my_app"."accounts" ("id" int);';
      expect(stripSchemaFromSql(sql)).toBe('CREATE TABLE "accounts" ("id" int);');
    });

    it("preserves cross-schema references when stripping primary schema", () => {
      const sql = 'CREATE TABLE "public"."users" ("org_id" int REFERENCES "auth"."org"("id"));';
      expect(stripSchemaFromSql(sql, "public")).toBe('CREATE TABLE "users" ("org_id" int REFERENCES "auth"."org"("id"));');
    });

    it("results in equal diff hunks when two tables only differ by schema name", () => {
      const sourceDdl = `CREATE TABLE "public"."users" (
  "id" integer NOT NULL,
  "name" text NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "users_name_idx" ON "public"."users" ("name");`;

      const targetDdl = `CREATE TABLE "test_schema"."users" (
  "id" integer NOT NULL,
  "name" text NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "users_name_idx" ON "test_schema"."users" ("name");`;

      const rawHunks = buildHunks(sourceDdl, targetDdl);
      const hasChangesRaw = rawHunks.some((h) => h.type !== "equal");
      expect(hasChangesRaw).toBe(true);

      const cleanSource = stripSchemaFromSql(sourceDdl, "public");
      const cleanTarget = stripSchemaFromSql(targetDdl, "test_schema");
      const normalizedHunks = buildHunks(cleanSource, cleanTarget);

      expect(normalizedHunks.every((h) => h.type === "equal")).toBe(true);
    });
  });
});
