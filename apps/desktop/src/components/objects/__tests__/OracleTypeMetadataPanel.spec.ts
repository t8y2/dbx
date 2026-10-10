// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OracleTypeMetadataPanel from "@/components/objects/OracleTypeMetadataPanel.vue";
import type { OracleTypeDetails } from "@/types/oracleTypes";

const mocks = vi.hoisted(() => ({ getOracleTypeDetails: vi.fn(), cancelQuery: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({
  getOracleTypeDetails: (...args: unknown[]) => mocks.getOracleTypeDetails(...args),
  cancelQuery: (...args: unknown[]) => mocks.cancelQuery(...args),
}));
vi.mock("@/components/ui/button", () => ({
  Button: defineComponent({
    setup:
      (_, { attrs, slots }) =>
      () =>
        h("button", attrs, slots.default?.()),
  }),
}));

type Target = { connectionId: string; database: string; schema: string; name: string; objectType: "TYPE" | "TYPE_BODY" };
const initialTarget: Target = { connectionId: "oracle-a", database: "service", schema: 'App."Owner', name: "Mixed.Type", objectType: "TYPE" };

function details(overrides: Partial<OracleTypeDetails> = {}): OracleTypeDetails {
  return {
    identity: { schema: initialTarget.schema, name: initialTarget.name, object_type: "TYPE" },
    status: "INVALID",
    paired_object: { schema: initialTarget.schema, name: initialTarget.name, object_type: "TYPE_BODY" },
    pairing_state: "available",
    dependencies: { state: "empty", rows: [] },
    grants: { state: "empty", rows: [] },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement;

function mount(target: Target = { ...initialTarget }) {
  const props = reactive(target);
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(defineComponent({ setup: () => () => h(OracleTypeMetadataPanel, props) }));
  app.use(createI18n({ legacy: false, locale: "en", fallbackLocale: "en", messages: { en: {} } }));
  app.mount(root);
  return props;
}

async function flush() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function click(label: string) {
  const button = Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
  expect(button).toBeDefined();
  button!.click();
  await flush();
}

beforeEach(() => {
  mocks.getOracleTypeDetails.mockReset();
  mocks.cancelQuery.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  vi.unstubAllGlobals();
});

describe("OracleTypeMetadataPanel", () => {
  it("loads metadata without randomUUID in an HTTP context and clears loading", async () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const pending = deferred<OracleTypeDetails>();
    mocks.getOracleTypeDetails.mockReturnValueOnce(pending.promise);
    mount();
    await flush();
    expect(mocks.getOracleTypeDetails).toHaveBeenCalledOnce();
    expect(mocks.getOracleTypeDetails.mock.calls[0][5]).toMatch(/^oracle-type-[\da-f-]{36}$/);
    expect(root.querySelector('[role="status"]')?.textContent).toBe("Loading");
    pending.resolve(details());
    await flush();
    expect(root.textContent).toContain("INVALID");
    expect(root.querySelector('[role="status"]')).toBeNull();
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows initialization failure and clears loading before a backend request", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: () => {
        throw new Error("Random source unavailable");
      },
    });
    mount();
    await flush();
    expect(mocks.getOracleTypeDetails).not.toHaveBeenCalled();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("Random source unavailable");
    expect(root.querySelector('[role="status"]')).toBeNull();
  });

  it("preserves exact owner, name and specification/body identity at the backend boundary", async () => {
    mocks.getOracleTypeDetails.mockResolvedValue(details());
    const props = mount();
    await flush();
    expect(mocks.getOracleTypeDetails).toHaveBeenLastCalledWith("oracle-a", "service", 'App."Owner', "Mixed.Type", "TYPE", expect.any(String));
    expect(root.textContent).toContain("INVALID");
    expect(root.textContent).toContain('App."Owner.Mixed.Type (TYPE_BODY)');
    props.objectType = "TYPE_BODY";
    await flush();
    expect(mocks.getOracleTypeDetails).toHaveBeenLastCalledWith("oracle-a", "service", 'App."Owner', "Mixed.Type", "TYPE_BODY", expect.any(String));
  });

  it("distinguishes unknown status, unavailable dependencies and an empty visible grant list", async () => {
    mocks.getOracleTypeDetails.mockResolvedValue(
      details({
        status: null,
        paired_object: null,
        pairing_state: "unknown",
        dependencies: { state: "denied", rows: [], message: "ORA-01031: insufficient privileges" },
        grants: { state: "empty", rows: [] },
      }),
    );
    mount();
    await flush();
    expect(root.textContent).toContain("Status: Unknown");
    expect(root.textContent).not.toContain("VALID");
    const sections = root.querySelectorAll("details");
    expect(sections[0].textContent).toContain("Permission denied");
    expect(sections[0].textContent).toContain("ORA-01031");
    expect(sections[0].textContent).not.toContain("No visible rows");
    expect(sections[1].textContent).toContain("No visible rows");
  });

  it("shows the visible target, remote link and grant option without conflating them with effective permissions", async () => {
    mocks.getOracleTypeDetails.mockResolvedValue(
      details({
        dependencies: { state: "available", rows: [{ schema: initialTarget.schema, name: initialTarget.name, object_type: "TYPE", referenced_schema: "Other.Owner", referenced_name: 'Type"Name', referenced_type: "TYPE", referenced_link: "REMOTE", dependency_type: "HARD" }] },
        grants: { state: "available", rows: [{ grantor: initialTarget.schema, grantee: "Some Role", privilege: "EXECUTE", grantable: null }] },
      }),
    );
    mount();
    await flush();
    expect(root.textContent).toContain('Other.Owner.Type"Name (TYPE) @REMOTE');
    expect(root.textContent).toContain("Some Role: EXECUTE");
    expect(root.textContent).toContain("Grant option: Unknown");
    expect(root.textContent).toContain("Grants do not include effective role inheritance");
  });

  it("cancels the old request and ignores its late response after switching connection and schema", async () => {
    const old = deferred<OracleTypeDetails>();
    mocks.getOracleTypeDetails.mockReturnValueOnce(old.promise).mockResolvedValueOnce(details({ status: "NEW_CONTEXT" }));
    const props = mount();
    await flush();
    const firstId = mocks.getOracleTypeDetails.mock.calls[0][5];
    Object.assign(props, { connectionId: "ob-b", database: "tenant", schema: "Other", name: "T", objectType: "TYPE_BODY" });
    await flush();
    expect(mocks.cancelQuery).toHaveBeenCalledWith(firstId);
    expect(mocks.getOracleTypeDetails).toHaveBeenLastCalledWith("ob-b", "tenant", "Other", "T", "TYPE_BODY", expect.any(String));
    old.resolve(details({ status: "OLD_CONTEXT" }));
    await flush();
    expect(root.textContent).toContain("NEW_CONTEXT");
    expect(root.textContent).not.toContain("OLD_CONTEXT");
  });

  it("keeps cancellation visible when the cancelled request resolves and refreshes the same target", async () => {
    const pending = deferred<OracleTypeDetails>();
    mocks.getOracleTypeDetails.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(details({ status: "VALID" }));
    mount();
    await flush();
    const firstId = mocks.getOracleTypeDetails.mock.calls[0][5];
    await click("Cancel");
    expect(mocks.cancelQuery).toHaveBeenCalledWith(firstId);
    pending.resolve(details());
    await flush();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Cancelled");
    expect(root.textContent).not.toContain("INVALID");
    await click("Refresh");
    expect(root.textContent).toContain("VALID");
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.getOracleTypeDetails.mock.calls[1].slice(0, 5)).toEqual(mocks.getOracleTypeDetails.mock.calls[0].slice(0, 5));
    expect(mocks.getOracleTypeDetails.mock.calls[1][5]).not.toBe(firstId);
  });

  it("shows a failed read without an empty success and permits explicit retry", async () => {
    mocks.getOracleTypeDetails.mockRejectedValueOnce(new Error("Dictionary unavailable")).mockResolvedValueOnce(details());
    mount();
    await flush();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("Dictionary unavailable");
    expect(root.querySelectorAll("details")).toHaveLength(0);
    await click("Refresh");
    expect(root.textContent).toContain("INVALID");
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it("cancels a pending request on unmount", async () => {
    const pending = deferred<OracleTypeDetails>();
    mocks.getOracleTypeDetails.mockReturnValueOnce(pending.promise);
    mount();
    await flush();
    const executionId = mocks.getOracleTypeDetails.mock.calls[0][5];
    app!.unmount();
    app = undefined;
    expect(mocks.cancelQuery).toHaveBeenCalledWith(executionId);
    pending.reject(new Error("Cancelled by server"));
    await flush();
    expect(root.textContent).toBe("");
  });
});
