// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { copyToClipboard } from "@/lib/common/clipboard";
import { redisFlushDbPreview, redisDeleteKeysPreview, redisDeleteGroupPreview, redisDeleteValueItemPreview } from "@/lib/redis/redisCommandPreview";

vi.mock("@/composables/useSqlHighlighter", () => ({
  useSqlHighlighter: () => ({
    highlight: (sql: string) => `<span>${sql.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span>`,
  }),
}));

vi.mock("@/lib/common/clipboard", () => ({
  copyToClipboard: vi.fn(),
}));

const mountedApps: App[] = [];

async function mountDangerDialog(props: Record<string, unknown>) {
  const state = reactive({ open: true });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(DangerConfirmDialog, {
          open: state.open,
          ...props,
          "onUpdate:open": (value: boolean) => {
            state.open = value;
          },
        }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return container;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.mocked(copyToClipboard).mockClear();
});

describe("Redis DangerConfirmDialog copy command behavior (issue #12892)", () => {
  it("copies the FLUSHDB command instead of the details text", async () => {
    const sql = redisFlushDbPreview(6);
    const detailsText = "目标: Redis db6\n范围: 当前 DB 的所有 key";

    await mountDangerDialog({
      title: "清空当前 DB",
      message: "这会删除当前 Redis 数据库中的所有 key，且不可撤销。确认继续？",
      detailsText,
      sql,
    });

    const codeContainer = document.body.querySelector('[data-testid="danger-code-container"]');
    expect(codeContainer).not.toBeNull();
    expect(codeContainer?.textContent).toContain("SELECT 6");
    expect(codeContainer?.textContent).toContain("FLUSHDB");
    expect(codeContainer?.textContent).not.toContain("目标: Redis db6");

    const copyBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="danger-code-actions"] button');
    expect(copyBtn).not.toBeNull();
    copyBtn?.click();
    await nextTick();

    expect(copyToClipboard).toHaveBeenCalledWith("SELECT 6\nFLUSHDB");
  });

  it("copies DEL command when batch deleting keys instead of description text", async () => {
    const keys = ["user:1", "user:2", "cache:session with space"];
    const sql = redisDeleteKeysPreview(keys);
    const detailsText = "已选择的 key\n3 个 key";

    await mountDangerDialog({
      title: "删除确认",
      message: "确认删除选中的内容？",
      detailsText,
      sql,
    });

    const codeContainer = document.body.querySelector('[data-testid="danger-code-container"]');
    expect(codeContainer?.textContent).toContain("DEL user:1 user:2");
    expect(codeContainer?.textContent).toContain('"cache:session with space"');

    const copyBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="danger-code-actions"] button');
    copyBtn?.click();
    await nextTick();

    expect(copyToClipboard).toHaveBeenCalledWith('DEL user:1 user:2 "cache:session with space"');
  });

  it("copies bounded scan-and-delete command when deleting a group instead of EVAL", async () => {
    const pattern = "app:cache:*";
    const sql = redisDeleteGroupPreview(pattern, { database: 2 });
    const detailsText = "app:cache\n将删除该分组下的全部 key（已加载 10 个）";

    await mountDangerDialog({
      title: "删除确认",
      message: "确认删除选中的内容？",
      detailsText,
      sql,
    });

    const codeContainer = document.body.querySelector('[data-testid="danger-code-container"]');
    expect(codeContainer?.textContent).toContain("# Applicable: Standalone Redis (db 2)");
    expect(codeContainer?.textContent).toContain("python3 - << 'EOF'");
    expect(codeContainer?.textContent).toContain('PATTERN = "app:cache:*".encode("utf-8")');
    expect(codeContainer?.textContent).toContain("DB = 2");
    expect(codeContainer?.textContent).toContain("BATCH_SIZE = 512");
    expect(codeContainer?.textContent).not.toContain("xargs");
    expect(codeContainer?.textContent).not.toContain("EVAL");

    const copyBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="danger-code-actions"] button');
    copyBtn?.click();
    await nextTick();

    expect(copyToClipboard).toHaveBeenCalledWith(sql);
  });

  it("copies HDEL command with byte-accurate escaping when deleting a hash field in RedisValueViewer", async () => {
    const binaryBlob = { raw_base64: btoa("data\x00\xff"), encoding: "binary" };
    const sql = redisDeleteValueItemPreview("user\\profile", { kind: "hash", field: binaryBlob }, { database: 3 });
    const detailsText = "Redis key：user\\profile\nField: data";

    await mountDangerDialog({
      title: "删除确认",
      message: "确认删除选中的内容？",
      detailsText,
      sql,
    });

    const codeContainer = document.body.querySelector('[data-testid="danger-code-container"]');
    expect(codeContainer?.textContent).toContain("SELECT 3");
    expect(codeContainer?.textContent).toContain('HDEL "user\\\\profile" "data\\x00\\xff"');

    const copyBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="danger-code-actions"] button');
    copyBtn?.click();
    await nextTick();

    expect(copyToClipboard).toHaveBeenCalledWith('SELECT 3\nHDEL "user\\\\profile" "data\\x00\\xff"');
  });

  it("copies SREM command when deleting a set member in RedisValueViewer", async () => {
    const sql = redisDeleteValueItemPreview("tags:article", { kind: "set", member: "news" });
    const detailsText = "Redis key：tags:article\nMember: news";

    await mountDangerDialog({
      title: "删除确认",
      message: "确认删除选中的内容？",
      detailsText,
      sql,
    });

    const codeContainer = document.body.querySelector('[data-testid="danger-code-container"]');
    expect(codeContainer?.textContent).toContain("SREM tags:article news");

    const copyBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="danger-code-actions"] button');
    copyBtn?.click();
    await nextTick();

    expect(copyToClipboard).toHaveBeenCalledWith("SREM tags:article news");
  });

  it("copies ZREM command when deleting a zset member in RedisValueViewer", async () => {
    const sql = redisDeleteValueItemPreview("leaderboard", { kind: "zset", member: "player1" });
    const detailsText = "Redis key：leaderboard\nMember: player1";

    await mountDangerDialog({
      title: "删除确认",
      message: "确认删除选中的内容？",
      detailsText,
      sql,
    });

    const codeContainer = document.body.querySelector('[data-testid="danger-code-container"]');
    expect(codeContainer?.textContent).toContain("ZREM leaderboard player1");

    const copyBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="danger-code-actions"] button');
    copyBtn?.click();
    await nextTick();

    expect(copyToClipboard).toHaveBeenCalledWith("ZREM leaderboard player1");
  });
});
