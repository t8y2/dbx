import { readFileSync } from "node:fs";
import { parse } from "vue/compiler-sfc";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
const parsedDialog = parse(dialogSource, { filename: "ConnectionDialog.vue" });

function functionSource(name: string): string {
  const script = parsedDialog.descriptor.scriptSetup;
  expect(parsedDialog.errors).toEqual([]);
  expect(script).toBeDefined();

  const source = ts.createSourceFile("ConnectionDialog.vue.ts", script!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  expect(declaration).toBeDefined();
  return declaration!.getText();
}

interface ProfileDraft {
  port: number;
  username: string;
  url_params: string;
  agent_java_options: string[];
}

function profileSwitchHarness(selectedProfile: string, editing = false) {
  const form: ProfileDraft = {
    port: 15432,
    username: "draft-user",
    url_params: "sslmode=require&application_name=dbx",
    agent_java_options: ["-Xms256m", "-Xmx1g"],
  };
  const editingId: { value: string | null } = { value: editing ? "connection-1" : null };
  const selectedType = { value: selectedProfile };
  const selectedDbCategory = { value: "sql" };
  const customDriverName = { value: selectedProfile.startsWith("custom_") ? `Draft ${selectedProfile}` : "" };
  const events: string[] = [];
  const defaults: Record<string, ProfileDraft> = {
    mysql: { port: 3306, username: "root", url_params: "", agent_java_options: [] },
    postgres: { port: 5432, username: "postgres", url_params: "", agent_java_options: [] },
  };

  function resetForm(options: { preservePickerState?: boolean }) {
    events.push(`reset:${options.preservePickerState === true}`);
    Object.assign(form, defaults.mysql);
    selectedType.value = "mysql";
    customDriverName.value = "";
  }

  function applyProfile(profile: string, preserveConnectionFields: boolean) {
    events.push(`apply:${profile}:${preserveConnectionFields}`);
    selectedType.value = profile;
    if (!preserveConnectionFields) {
      const defaultProfile = profile.includes("postgres") ? defaults.postgres : defaults.mysql;
      Object.assign(form, defaultProfile);
    }
  }

  const javascript = ts.transpileModule(functionSource("onDbTypeChange"), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const selectProfile = new Function("editingId", "selectedType", "resetForm", "dbCategoryForOption", "selectedDbCategory", "customDriverName", "applyProfile", "resetTestState", "resetVisibleSchemasState", `${javascript}\nreturn onDbTypeChange;`)(
    editingId,
    selectedType,
    resetForm,
    () => "sql",
    selectedDbCategory,
    customDriverName,
    applyProfile,
    () => events.push("reset-test"),
    () => events.push("reset-schemas"),
  ) as (profile: string) => void;

  return { customDriverName, events, form, selectProfile, selectedType };
}

function igniteProfileSwitchHarness(selectedProfile: "ignite" | "ignite3") {
  const form = {
    value: {
      db_type: selectedProfile,
      driver_profile: selectedProfile,
      driver_label: selectedProfile === "ignite" ? "Apache Ignite 2.x" : "Apache Ignite 3.x",
      host: "ignite.example.com",
      port: 10800,
      username: "draft-user",
      password: "draft-password",
      database: "draft-database",
      ssl: true,
      url_params: "sslMode=require",
      connection_string: "jdbc:ignite:thin://ignite.example.com:10800/draft-database",
      agent_java_options: ["-Xms256m", "-Xmx1g"],
    },
  };
  const selectedType = { value: selectedProfile };
  const selectedDbCategory = { value: "sql" };
  const customDriverName = { value: "" };
  const events: string[] = [];

  function applyProfile(profile: "ignite" | "ignite3", preserveConnectionFields: boolean) {
    events.push(`apply:${profile}:${preserveConnectionFields}`);
    selectedType.value = profile;
    form.value.db_type = profile;
    form.value.driver_profile = profile;
    form.value.driver_label = profile === "ignite" ? "Apache Ignite 2.x" : "Apache Ignite 3.x";
    if (!preserveConnectionFields) {
      form.value.host = "127.0.0.1";
      form.value.username = "";
      form.value.password = "";
      form.value.database = "";
      form.value.ssl = false;
      form.value.url_params = "";
      form.value.connection_string = "";
      form.value.agent_java_options = [];
    }
  }

  const javascript = ts.transpileModule(functionSource("selectIgniteConnectionProfile"), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const selectProfile = new Function("form", "selectedType", "dbCategoryForOption", "selectedDbCategory", "customDriverName", "applyProfile", "resetTestState", "resetVisibleSchemasState", `${javascript}\nreturn selectIgniteConnectionProfile;`)(
    form,
    selectedType,
    () => "sql",
    selectedDbCategory,
    customDriverName,
    applyProfile,
    () => events.push("reset-test"),
    () => events.push("reset-schemas"),
  ) as (profile: "ignite" | "ignite3") => void;

  return { events, form, selectProfile, selectedType };
}

describe("ConnectionDialog database profile switching", () => {
  it.each([
    ["mysql", ""],
    ["custom_mysql", "Draft custom_mysql"],
    ["custom_postgres", "Draft custom_postgres"],
  ])("preserves a new %s draft when the current profile is selected again", (profile, driverName) => {
    const harness = profileSwitchHarness(profile);
    const formBeforeReselect = structuredClone(harness.form);

    harness.selectProfile(profile);

    expect(harness.form.port).toBe(formBeforeReselect.port);
    expect(harness.form.username).toBe(formBeforeReselect.username);
    expect(harness.form.url_params).toBe(formBeforeReselect.url_params);
    expect(harness.form.agent_java_options).toEqual(formBeforeReselect.agent_java_options);
    expect(harness.customDriverName.value).toBe(driverName);
    expect(harness.selectedType.value).toBe(profile);
    expect(harness.events).toEqual([]);
  });

  it("resets the new connection draft before selecting a different profile", () => {
    const harness = profileSwitchHarness("mysql");

    harness.selectProfile("postgres");

    expect(harness.form).toEqual({ port: 5432, username: "postgres", url_params: "", agent_java_options: [] });
    expect(harness.customDriverName.value).toBe("");
    expect(harness.selectedType.value).toBe("postgres");
    expect(harness.events).toEqual(["reset:true", "apply:postgres:false", "reset-test", "reset-schemas"]);
  });

  it("keeps the existing edit-path behavior when reselecting its profile", () => {
    const harness = profileSwitchHarness("custom_mysql", true);
    const formBeforeReselect = structuredClone(harness.form);

    harness.selectProfile("custom_mysql");

    expect(harness.form).toEqual(formBeforeReselect);
    expect(harness.customDriverName.value).toBe("");
    expect(harness.events).toEqual(["apply:custom_mysql:true", "reset-test", "reset-schemas"]);
  });

  it.each([
    ["ignite", "ignite3"],
    ["ignite3", "ignite"],
  ] as const)("preserves an Ignite %s draft when switching to %s", (from, to) => {
    const harness = igniteProfileSwitchHarness(from);
    const connectionFields = {
      host: harness.form.value.host,
      port: harness.form.value.port,
      username: harness.form.value.username,
      password: harness.form.value.password,
      database: harness.form.value.database,
      ssl: harness.form.value.ssl,
      url_params: harness.form.value.url_params,
      connection_string: harness.form.value.connection_string,
      agent_java_options: [...harness.form.value.agent_java_options],
    };

    harness.selectProfile(to);

    expect(harness.form.value).toMatchObject(connectionFields);
    expect(harness.form.value.db_type).toBe(to);
    expect(harness.form.value.driver_profile).toBe(to);
    expect(harness.selectedType.value).toBe(to);
    expect(harness.events).toEqual([`apply:${to}:true`, "reset-test", "reset-schemas"]);
  });
});
