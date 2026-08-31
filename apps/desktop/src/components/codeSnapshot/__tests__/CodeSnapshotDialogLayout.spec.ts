import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../CodeSnapshotDialog.vue", import.meta.url), "utf8");

describe("CodeSnapshotDialog layout", () => {
  it("keeps the exported snapshot at its intrinsic width inside the scrollable preview", () => {
    // 截图节点不能被外层 flex 布局压缩，否则长代码导出时会被裁切或错误换行。
    expect(dialogSource).toContain('v-html="snapshotHtml" class="flex w-max min-w-[320px] flex-none"');
  });
});
