import { describe, expect, it } from "vitest";
import { classifySqlRisk, isSqlRiskMutation } from "@/lib/sql/sqlRisk";

/**
 * The type designer routes its statement through the same production guard the
 * SQL editor uses, and that guard only asks for confirmation when the SQL is
 * classified as a mutation. A type-management statement that classified as a
 * read would silently skip the confirmation on a production database, so every
 * form the planner can emit is pinned here.
 */
describe("custom type DDL counts as a mutation", () => {
  const statements = [
    'CREATE TYPE "app"."status" AS ENUM (\'draft\');',
    'CREATE TYPE "app"."address" AS (\n  "city" text\n);',
    'CREATE DOMAIN "app"."email" AS text\n  NOT NULL;',
    'CREATE TYPE "app"."price_range" AS RANGE (\n  subtype = numeric\n);',
    "ALTER TYPE \"app\".\"status\" ADD VALUE 'archived' AFTER 'published';",
    "ALTER TYPE \"app\".\"status\" RENAME VALUE 'draft' TO 'pending';",
    'ALTER TYPE "app"."address" ADD ATTRIBUTE "country" text RESTRICT;',
    'ALTER TYPE "app"."address" RENAME ATTRIBUTE "city" TO "town" RESTRICT;',
    'ALTER TYPE "app"."address" ALTER ATTRIBUTE "zip" SET DATA TYPE varchar(12) RESTRICT;',
    'ALTER TYPE "app"."address" DROP ATTRIBUTE "legacy" RESTRICT;',
    'ALTER TYPE "app"."status" RENAME TO "order_status";',
    'ALTER TYPE "app"."order_status" SET SCHEMA "shared";',
    'ALTER TYPE "app"."order_status" OWNER TO "app_owner";',
    'ALTER DOMAIN "app"."email" SET DEFAULT \'\'::text;',
    'ALTER DOMAIN "app"."email" DROP DEFAULT;',
    'ALTER DOMAIN "app"."email" SET NOT NULL;',
    'ALTER DOMAIN "app"."email" ADD CONSTRAINT "email_valid" CHECK (VALUE <> \'\');',
    'ALTER DOMAIN "app"."email" RENAME CONSTRAINT "a" TO "b";',
    'ALTER DOMAIN "app"."email" DROP CONSTRAINT "email_valid" RESTRICT;',
    'ALTER DOMAIN "app"."email" VALIDATE CONSTRAINT "email_valid";',
    'COMMENT ON TYPE "app"."status" IS \'order status\';',
    'COMMENT ON DOMAIN "app"."email" IS NULL;',
    'COMMENT ON COLUMN "app"."address"."city" IS \'city\';',
    'DROP TYPE "app"."status" RESTRICT;',
    'DROP TYPE "app"."status" CASCADE;',
    'DROP DOMAIN "app"."email" RESTRICT;',
  ];

  for (const sql of statements) {
    it(sql, () => {
      expect(isSqlRiskMutation(classifySqlRisk(sql, { dialect: "postgres" }).risk)).toBe(true);
    });
  }
});
