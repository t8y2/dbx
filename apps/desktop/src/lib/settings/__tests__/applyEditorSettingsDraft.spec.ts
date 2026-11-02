import { ref } from "vue";
import { describe, expect, it } from "vitest";
import { applyEditorSettingsDraftToRefs } from "../applyEditorSettingsDraft";
import type { EditorSettingsDraft } from "../editorSettingsDraft";

describe("applyEditorSettingsDraftToRefs", () => {
  it("applies only the requested keys and preserves custom transforms", () => {
    const fontSize = ref(12);
    const theme = ref("light");
    const draft = { fontSize: 16, theme: "dark" } as EditorSettingsDraft;

    applyEditorSettingsDraftToRefs(draft, ["fontSize"], { fontSize, theme }, { fontSize: (value) => Number(value) + 1 });

    expect(fontSize.value).toBe(17);
    expect(theme.value).toBe("light");
  });
});
