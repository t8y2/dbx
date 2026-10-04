import { describe, expect, it } from "vitest";
import { generateModel, MODEL_RENDERERS } from "./modelRendererRegistry";
import { modelShapeFromTable } from "./modelShape";
import { renderModelTemplate } from "./modelTemplates";

const node = { id: "table-1", label: "user_accounts", type: "table", connectionId: "c1", database: "app", schema: "public", comment: "Accounts" } as const;
const columns = [
  { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: "Identifier" },
  { name: "display_name", data_type: "varchar(80)", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: "Visible name" },
];

describe("model generation", () => {
  it("registers the fifteen Schemato-compatible SQL targets", () => {
    expect(MODEL_RENDERERS.map((item) => item.id)).toEqual(["typescript", "zod", "yup", "joi", "pydantic", "python-dataclass", "go-struct", "rust-struct", "kotlin", "swift", "dart", "java", "csharp", "php", "ruby"]);
  });

  it("preserves metadata while rendering a target", () => {
    const shape = modelShapeFromTable(node, columns, "postgres");
    const code = generateModel(shape, "csharp", { includeHeaderComments: true });
    expect(code).toContain("UserAccounts");
    expect(code).toContain("Identifier");
    expect(code).toContain("long Id");
    expect(code).toContain("string? DisplayName");
  });

  it("hides generated schema comments by default", () => {
    const shape = modelShapeFromTable(node, columns, "postgres");
    const code = generateModel(shape, "go-struct");
    expect(code).not.toContain("// id: bigint");
    expect(generateModel(shape, "go-struct", { includeHeaderComments: true })).toContain("// id: bigint");
  });

  it("supports safe custom templates with column loops and conditions", () => {
    const shape = modelShapeFromTable(node, columns);
    expect(renderModelTemplate("{{class.name}}\n{{#columns}}{{column.name}} {{#column.primaryKey}}PK{{/column.primaryKey}}\n{{/columns}}", shape)).toBe("UserAccounts\nid PK\ndisplay_name \n");
  });
});
