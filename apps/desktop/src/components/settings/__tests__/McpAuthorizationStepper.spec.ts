// @vitest-environment happy-dom
// MCP 授权步骤条回归测试（#9309）：
// 末步（第 4 步「汇总与确认」）没有下一页可去，右侧按钮不再显示可点的“下一步”。
// 1) 第 1-3 步：右侧“下一步”可见可点，点击前进一格；左侧“上一步”第 1 步禁用、其后可点。
// 2) 第 4 步：右侧按钮带 invisible 且 disabled，但仍留在 footer 中作同尺寸占位。
// 3) 第 4 步点“上一步”回到第 3 步后，右侧按钮恢复可见。
// 4) 顶部步骤条四个步骤都能直达，末步右侧按钮同样隐藏。
// 5) 末步占位按钮不可聚焦。
// 6) 正向对照：非末步的“下一步”按钮可以聚焦——证明这个环境能表达焦点，第 5 条才不是恒真。
//
// 哪些用例真正守住 #9309：第 2、4 条（断言 invisible 与 footer 计数）。把组件还原到修复前，
// 恰好是这两条失败。第 5 条在修复前也通过——末步按钮本来就带 disabled，所以它是防止后人
// 删掉 disabled 的前瞻守卫，而不是本次缺陷的回归守卫，勿误读。
//
// 说明：happy-dom 无排版引擎、不加载 Tailwind 样式表，因此“进度文案是否真的居中/不位移”
// 这类几何断言在单测里无法表达，只以“占位仍留在 DOM 中”作为可证伪的替代断言。

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${params.current}/${params.total}` : key),
  }),
}));

import McpAuthorizationStepper from "@/components/settings/McpAuthorizationStepper.vue";

let harness: { app: App<Element>; root: HTMLElement } | null = null;

function mountStepper() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = createApp(McpAuthorizationStepper);
  app.mount(root);
  harness = { app, root };
  return root;
}

afterEach(() => {
  harness?.app?.unmount();
  harness = null;
  document.body.innerHTML = "";
});

function buttonByText(root: HTMLElement, key: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find((el) => el.textContent?.trim() === key);
  if (!button) throw new Error(`button ${key} not found`);
  return button as HTMLButtonElement;
}

function nextButton(root: HTMLElement) {
  return buttonByText(root, "settings.mcpAuthNextStep");
}

function prevButton(root: HTMLElement) {
  return buttonByText(root, "settings.mcpAuthPreviousStep");
}

function navStep(root: HTMLElement, index: number) {
  const nav = root.querySelector("nav");
  if (!nav) throw new Error("step nav not found");
  const button = nav.querySelectorAll("button")[index];
  if (!button) throw new Error(`nav step ${index} not found`);
  return button as HTMLButtonElement;
}

function progress(root: HTMLElement) {
  return root.textContent?.match(/settings\.mcpAuthStepProgress:\d+\/\d+/)?.[0];
}

async function goToLastStep(root: HTMLElement) {
  for (let i = 0; i < 3; i += 1) {
    nextButton(root).click();
    await nextTick();
  }
}

describe("McpAuthorizationStepper", () => {
  it("第 1 步：右侧为可见可点的“下一步”，左侧“上一步”禁用", () => {
    const root = mountStepper();

    expect(progress(root)).toBe("settings.mcpAuthStepProgress:1/4");
    expect(nextButton(root).classList.contains("invisible")).toBe(false);
    expect(nextButton(root).disabled).toBe(false);
    expect(prevButton(root).disabled).toBe(true);
  });

  it("逐级前进：第 2、3 步右侧仍是可见可点的“下一步”，左侧“上一步”可点", async () => {
    const root = mountStepper();

    nextButton(root).click();
    await nextTick();
    expect(progress(root)).toBe("settings.mcpAuthStepProgress:2/4");
    expect(nextButton(root).classList.contains("invisible")).toBe(false);
    expect(nextButton(root).disabled).toBe(false);
    expect(prevButton(root).disabled).toBe(false);

    nextButton(root).click();
    await nextTick();
    expect(progress(root)).toBe("settings.mcpAuthStepProgress:3/4");
    expect(nextButton(root).classList.contains("invisible")).toBe(false);
    expect(nextButton(root).disabled).toBe(false);
    expect(prevButton(root).disabled).toBe(false);
  });

  it("第 4 步：右侧按钮隐藏且禁用，但仍留在 footer 中撑住布局", async () => {
    const root = mountStepper();
    await goToLastStep(root);

    expect(progress(root)).toBe("settings.mcpAuthStepProgress:4/4");
    // footer 仍是 [上一步][进度][占位] 三个子元素，即占位按钮没有被 v-if 摘掉——摘掉的话这里只剩 1 个。
    expect(root.querySelectorAll("footer button").length).toBe(2);

    const next = nextButton(root);
    expect(next.classList.contains("invisible")).toBe(true);
    expect(next.disabled).toBe(true);
    expect(prevButton(root).disabled).toBe(false);
  });

  it("第 4 步点“上一步”回到第 3 步后，右侧按钮恢复可见可点", async () => {
    const root = mountStepper();
    await goToLastStep(root);

    prevButton(root).click();
    await nextTick();

    expect(progress(root)).toBe("settings.mcpAuthStepProgress:3/4");
    expect(nextButton(root).classList.contains("invisible")).toBe(false);
    expect(nextButton(root).disabled).toBe(false);
  });

  it("顶部步骤条四个步骤均可直达，末步的右侧按钮同样隐藏", async () => {
    const root = mountStepper();

    for (let index = 0; index < 4; index += 1) {
      navStep(root, index).click();
      await nextTick();
      expect(progress(root)).toBe(`settings.mcpAuthStepProgress:${index + 1}/4`);
      expect(nextButton(root).classList.contains("invisible")).toBe(index === 3);
    }
    expect(nextButton(root).disabled).toBe(true);
  });

  // 正向对照：证明这个环境里 focus() 确实能生效，下面那条否定断言才不是恒真。
  it("正向对照：非末步的“下一步”按钮可以聚焦", () => {
    const root = mountStepper();

    nextButton(root).focus();
    expect(document.activeElement).toBe(nextButton(root));
  });

  // 每个用例独立挂载、起始焦点都不在任何按钮上——避免“元素已在焦点上、随后才被禁用”这种
  // 与断言无关的状态混进来（原生化不会因为元素被禁用就把已有焦点移走）。
  it("末步占位按钮不可聚焦", async () => {
    const root = mountStepper();
    await goToLastStep(root);

    const next = nextButton(root);
    next.focus();
    expect(document.activeElement).not.toBe(next);
    expect(next.disabled).toBe(true);
  });
});
