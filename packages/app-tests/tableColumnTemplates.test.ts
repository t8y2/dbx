import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createTableColumnTemplateDrafts, DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS, normalizeTableColumnTemplateFields, parseTableColumnTemplateFields, PRESET_FIELDS_TEMPLATE_ID, tableColumnTemplates, TABLE_COLUMN_TEMPLATE_DATABASE_TYPES } from "../../apps/desktop/src/lib/table/tableColumnTemplates.ts";

const sixCustomFields = [
  "tenant_id | mysql:bigint | postgres:uuid | default:0 | comment:Tenant",
  "request_id | mysql:varchar(64) | postgres:varchar(64)",
  "created_time | mysql:datetime | postgres:timestamp | default:CURRENT_TIMESTAMP",
  "modified_time | mysql:datetime | postgres:timestamp",
  "creator_id | mysql:bigint | postgres:bigint",
  "modifier_id | mysql:bigint | postgres:bigint | required:false",
];

test("has no built-in preset field names by default", () => {
  assert.deepEqual(DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS, []);
  assert.deepEqual(normalizeTableColumnTemplateFields(undefined), []);
  assert.deepEqual(normalizeTableColumnTemplateFields([]), []);
  assert.deepEqual(tableColumnTemplates(), [
    {
      id: PRESET_FIELDS_TEMPLATE_ID,
      labelKey: "structureEditor.presetFieldsTemplate",
      columnNames: [],
    },
  ]);
});

test("builds no preset field drafts until users configure fields", () => {
  const columns = createTableColumnTemplateDrafts({
    templateId: PRESET_FIELDS_TEMPLATE_ID,
    databaseType: "postgres",
    createId: () => "id",
  });

  assert.deepEqual(columns, []);
});

test("builds configured preset field drafts", () => {
  let id = 0;
  const columns = createTableColumnTemplateDrafts({
    templateId: PRESET_FIELDS_TEMPLATE_ID,
    databaseType: "mysql",
    columnNames: sixCustomFields,
    createId: () => String(++id),
  });

  assert.deepEqual(
    columns.map((column) => ({
      id: column.id,
      name: column.name,
      dataType: column.dataType,
      isNullable: column.isNullable,
      defaultValue: column.defaultValue,
      comment: column.comment,
    })),
    [
      { id: "new:1", name: "tenant_id", dataType: "bigint", isNullable: false, defaultValue: "0", comment: "Tenant" },
      { id: "new:2", name: "request_id", dataType: "varchar(64)", isNullable: false, defaultValue: "", comment: "" },
      { id: "new:3", name: "created_time", dataType: "datetime", isNullable: false, defaultValue: "CURRENT_TIMESTAMP", comment: "" },
      { id: "new:4", name: "modified_time", dataType: "datetime", isNullable: false, defaultValue: "", comment: "" },
      { id: "new:5", name: "creator_id", dataType: "bigint", isNullable: false, defaultValue: "", comment: "" },
      { id: "new:6", name: "modifier_id", dataType: "bigint", isNullable: true, defaultValue: "", comment: "" },
    ],
  );
});

test("filters configured fields by current database type", () => {
  const columns = createTableColumnTemplateDrafts({
    templateId: PRESET_FIELDS_TEMPLATE_ID,
    databaseType: "postgres",
    columnNames: ["mysql_only | mysql:bigint", "postgres_only | postgres:uuid", "common_name | mysql:<empty> | postgres:<empty>", "common_code | mysql:varchar(64) | postgres:varchar(32)"],
    createId: () => "id",
  });

  assert.deepEqual(
    columns.map((column) => ({ name: column.name, dataType: column.dataType })),
    [
      { name: "postgres_only", dataType: "uuid" },
      { name: "common_name", dataType: "" },
      { name: "common_code", dataType: "varchar(32)" },
    ],
  );
});

test("normalizes configured preset fields without adding built-in fields", () => {
  const [tenantId, requestId] = normalizeTableColumnTemplateFields([" tenant_id | mysql:bigint | postgres:uuid | default:0 ", "tenant_id | mysql:int", "", "request_id | mysql:varchar(64)"]);
  assert.equal(tenantId, "tenant_id | mysql:bigint | postgres:uuid | default:0");
  assert.equal(requestId, "request_id | mysql:varchar(64)");

  const parsed = parseTableColumnTemplateFields(["tenant_id | mysql:bigint | postgres:uuid | nullable:true | default:0 | comment:Tenant"]);
  assert.deepEqual(parsed[0], { name: "tenant_id", dataTypesByDatabase: { mysql: "bigint", postgres: "uuid" }, defaultValue: "0", isNullable: true, comment: "Tenant" });
});

test("limits preset field database types to create-table capable SQL structures", () => {
  assert.ok(TABLE_COLUMN_TEMPLATE_DATABASE_TYPES.includes("mysql"));
  assert.ok(TABLE_COLUMN_TEMPLATE_DATABASE_TYPES.includes("postgres"));
  assert.ok(TABLE_COLUMN_TEMPLATE_DATABASE_TYPES.includes("clickhouse"));
  assert.ok(!TABLE_COLUMN_TEMPLATE_DATABASE_TYPES.includes("mongodb"));
  assert.ok(!TABLE_COLUMN_TEMPLATE_DATABASE_TYPES.includes("redis"));
  assert.ok(!TABLE_COLUMN_TEMPLATE_DATABASE_TYPES.includes("elasticsearch"));
  assert.ok(!TABLE_COLUMN_TEMPLATE_DATABASE_TYPES.includes("manticoresearch"));
});

test("skips configured preset fields that already exist", () => {
  const columns = createTableColumnTemplateDrafts({
    templateId: PRESET_FIELDS_TEMPLATE_ID,
    databaseType: "mysql",
    columnNames: sixCustomFields,
    existingColumnNames: ["tenant_id", "MODIFIER_ID"],
    createId: () => "x",
  });

  assert.deepEqual(
    columns.map((column) => column.name),
    ["request_id", "created_time", "modified_time", "creator_id"],
  );
});
