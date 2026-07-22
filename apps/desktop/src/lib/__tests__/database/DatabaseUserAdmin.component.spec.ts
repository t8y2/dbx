// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
}));

function passthrough(tag: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@lucide/vue", () => {
  const Icon = passthrough("span");
  return {
    AlertTriangle: Icon,
    Check: Icon,
    KeyRound: Icon,
    Lock: Icon,
    Loader2: Icon,
    Plus: Icon,
    RefreshCcw: Icon,
    Search: Icon,
    ShieldCheck: Icon,
    Trash2: Icon,
    Unlock: Icon,
    UserRound: Icon,
  };
});
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/badge", () => ({ Badge: passthrough("span") }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: passthrough("div"),
  DialogContent: passthrough("div"),
  DialogFooter: passthrough("div"),
  DialogHeader: passthrough("div"),
  DialogTitle: passthrough("div"),
}));
vi.mock("@/components/ui/input", () => ({ Input: passthrough("input") }));
vi.mock("@/components/ui/PasswordInput.vue", () => ({ default: passthrough("input") }));
vi.mock("@/components/ui/select", () => ({
  Select: passthrough("div"),
  SelectContent: passthrough("div"),
  SelectItem: passthrough("div"),
  SelectTrigger: passthrough("div"),
  SelectValue: passthrough("span"),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ ensureConnected: mocks.ensureConnected }),
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  executeMulti: vi.fn(),
  listDatabases: vi.fn(),
  listSchemas: vi.fn(),
}));

import DatabaseUserAdmin from "@/components/admin/DatabaseUserAdmin.vue";

const connection: ConnectionConfig = {
  id: "oceanbase",
  name: "OceanBase",
  db_type: "jdbc",
  driver_profile: "mysql",
  host: "localhost",
  port: 2881,
  username: "root",
  password: "",
};

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  vi.clearAllMocks();
});

describe("DatabaseUserAdmin MySQL grant loading", () => {
  it("syncs privilege buttons and grant option from loaded SHOW GRANTS rows", async () => {
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeQuery.mockResolvedValueOnce({ columns: ["user", "host", "plugin"], rows: [["root", "%", "mysql_native_password"]] }).mockResolvedValueOnce({ columns: ["Grants for root@%"], rows: [["GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION"]] });

    root = document.createElement("div");
    document.body.append(root);
    app = createApp(DatabaseUserAdmin, { connection });
    app.mount(root);

    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    await nextTick();

    const privilegeButton = Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.trim() === "INSERT");
    const grantOptionLabel = Array.from(root.querySelectorAll("label")).find((label) => label.textContent?.includes("userAdmin.grantOption"));
    const grantOptionInput = grantOptionLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');

    expect(privilegeButton?.className).toContain("border-primary");
    expect(grantOptionInput?.checked).toBe(true);
  });
});
