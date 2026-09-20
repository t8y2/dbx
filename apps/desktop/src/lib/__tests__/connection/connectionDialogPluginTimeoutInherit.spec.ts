import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("ConnectionDialog plugin connection timeout inheritance", () => {
  const submitFn = dialogSource.slice(dialogSource.indexOf("function connectionConfigForSubmit"));
  const pluginBranch = submitFn.slice(0, submitFn.indexOf("} else {"));

  it("keeps the connect timeout inherit flag when submitting plugin connections", () => {
    // buildPluginConnectionConfig rebuilds the config from scratch and drops
    // the inherit flags; without this mirror the store normalizes the absent
    // flag back to the persisted scope and the Advanced-tab radio reverts.
    expect(pluginBranch).toContain("config.connect_timeout_inherit = form.value.connect_timeout_inherit;");
  });

  it("keeps the query timeout inherit flag when submitting plugin connections", () => {
    expect(pluginBranch).toContain("config.query_timeout_inherit = form.value.query_timeout_inherit;");
  });

  it("still forces connect inheritance off for providers declaring their own handshake timeout field", () => {
    // The resolvedPluginConnectTimeout override must run after the generic
    // mirror so a provider-declared connect_timeout_secs stays the single
    // source of truth and the host RPC deadline cannot inherit the global.
    const mirrorIndex = pluginBranch.indexOf("config.connect_timeout_inherit = form.value.connect_timeout_inherit;");
    const overrideIndex = pluginBranch.indexOf("config.connect_timeout_inherit = false;");
    expect(mirrorIndex).toBeGreaterThan(-1);
    expect(overrideIndex).toBeGreaterThan(mirrorIndex);
  });

  it("keeps the per-connection timeout scalars when submitting plugin connections", () => {
    // Toggling back to "current connection" must preserve the typed value:
    // the store treats a stored scalar with inherit=false as a local override.
    expect(pluginBranch).toContain("config.query_timeout_secs = form.value.query_timeout_secs;");
    expect(pluginBranch).toContain("config.connect_timeout_secs = form.value.connect_timeout_secs;");
  });
});

describe("ConnectionDialog plugin connection timeout scope UI", () => {
  const hydrateBlock = dialogSource.slice(dialogSource.indexOf("connect_timeout_inherit: config.connect_timeout_inherit === true"));
  const queryTimeoutRowStart = dialogSource.lastIndexOf("<div", dialogSource.indexOf('t("connection.queryTimeout")'));
  const connectTimeoutRowStart = dialogSource.lastIndexOf("<div", dialogSource.indexOf('t("connection.connectTimeout")'));

  it("hydrates the global scope only from an explicit inherit flag", () => {
    // Round trip with the submit mirror above: only a stored `true` counts as
    // "global", so a preserved flag reopens as global and a preserved scalar
    // reopens as a local override.
    expect(hydrateBlock).toContain("query_timeout_inherit: config.query_timeout_inherit === true,");
  });

  it("hides the generic query timeout radio from plugin connections", () => {
    // query_timeout_secs only feeds the database query pipeline, which plugin
    // connections (SSH, ...) never run, so the control would be dead weight.
    expect(dialogSource.slice(queryTimeoutRowStart, queryTimeoutRowStart + 220)).toContain('v-if="!isPluginConnection"');
  });

  it("keeps the generic connect timeout radio visible for plugin connections", () => {
    // Deliberate scope cut: for providers without their own handshake timeout
    // field the connect radio is still effective, so it stays rendered.
    expect(dialogSource.slice(connectTimeoutRowStart, connectTimeoutRowStart + 220)).not.toContain('v-if="!isPluginConnection"');
  });
});
