import { describe, expect, it } from "vitest";
import { frameBelongsToTarget, frameSourceCandidates } from "@/lib/debug/plDebugFrameSource";

/**
 * F7：调用栈帧 → 字典对象 / 是否就是当前目标。
 *
 * 映射错一个的表现是「点了没反应」或「把源码视图指到别的对象上」，所以两条判定都逐例钉住：
 * 包成员（两段名 → 包体）、独立子程序（裸名 → PROCEDURE/FUNCTION 回退）、三段名（owner +
 * 包 + 子程序）、匿名块帧（没有可加载的对象），以及「同一对象」的四种组合。
 */

const PROCEDURE_TARGET = { objectType: "PROCEDURE", objectName: "P_DEMO", packageName: null };

describe("frameSourceCandidates", () => {
  it("tries a bare routine name as a standalone routine first, then as a package body", () => {
    // 裸名既可能是独立子程序，也可能是包的初始化段（包名没有点号）；两种都要试。
    expect(frameSourceCandidates({ program: "P_DEMO" }, "APP")).toEqual([
      { owner: "APP", name: "P_DEMO", objectType: "PROCEDURE" },
      { owner: "APP", name: "P_DEMO", objectType: "PACKAGE_BODY" },
    ]);
  });

  it("prefers the package body for a two-part name, then an owner-qualified routine", () => {
    // `PKG.SUB` 与 `OWNER.SUB` 在回填文本里同形，顺序就是答案：先包体，再 owner 限定。
    expect(frameSourceCandidates({ program: "PKG.SUB" }, "APP")).toEqual([
      { owner: "APP", name: "PKG", objectType: "PACKAGE_BODY" },
      { owner: "PKG", name: "SUB", objectType: "PROCEDURE" },
    ]);
  });

  it("reads a three-part name as owner + package + member", () => {
    expect(frameSourceCandidates({ program: "SCOTT.PKG.SUB" }, "APP")).toEqual([
      { owner: "SCOTT", name: "PKG", objectType: "PACKAGE_BODY" },
      { owner: "SCOTT", name: "SUB", objectType: "PROCEDURE" },
    ]);
  });

  it("uses the frame's programOwner when the agent reported one", () => {
    expect(frameSourceCandidates({ program: "PKG.SUB", programOwner: "DBX_DEBUG" }, "APP")[0]).toMatchObject({ owner: "DBX_DEBUG" });
    expect(frameSourceCandidates({ program: "P_DEMO", programOwner: "DBX_DEBUG" }, "APP")[0]).toMatchObject({ owner: "DBX_DEBUG" });
  });

  it("offers nothing for a frame that names no object", () => {
    // Oracle 会把源码行放进 `source`（`program` 因此为空），匿名块帧也可能没有程序名。
    expect(frameSourceCandidates({ program: "", source: "  V_COUNT NUMBER := 0;" }, "APP")).toEqual([]);
    expect(frameSourceCandidates({ program: "ANONYMOUS BLOCK" }, "APP")).toEqual([]);
    expect(frameSourceCandidates({}, "APP")).toEqual([]);
    expect(frameSourceCandidates(null, "APP")).toEqual([]);
  });
});

describe("frameBelongsToTarget", () => {
  it("matches the target's own routine by name, with or without a package prefix", () => {
    expect(frameBelongsToTarget({ program: "P_DEMO" }, PROCEDURE_TARGET)).toBe(true);
    expect(frameBelongsToTarget({ program: "S.P_DEMO" }, PROCEDURE_TARGET)).toBe(true);
    expect(frameBelongsToTarget({ program: "p_demo" }, PROCEDURE_TARGET)).toBe(true);
    expect(frameBelongsToTarget({ program: "PKG.P_DEMO" }, PROCEDURE_TARGET)).toBe(true);
  });

  it("reports a different object as not the target", () => {
    expect(frameBelongsToTarget({ program: "OTHER" }, PROCEDURE_TARGET)).toBe(false);
    expect(frameBelongsToTarget({ program: "PKG.OTHER" }, PROCEDURE_TARGET)).toBe(false);
    // 帧没有程序名（Oracle 把源码行放在 source 里）时无法认定是目标，也就没有「另一个对象」可看。
    expect(frameBelongsToTarget({ program: "" }, PROCEDURE_TARGET)).toBe(false);
  });

  it("matches a package member target through its routine name", () => {
    const target = { objectType: "PROCEDURE", objectName: "SUB_A", packageName: "PKG" };
    expect(frameBelongsToTarget({ program: "PKG.SUB_A" }, target)).toBe(true);
    expect(frameBelongsToTarget({ program: "SUB_A" }, target)).toBe(true);
    expect(frameBelongsToTarget({ program: "PKG.SUB_B" }, target)).toBe(false);
  });

  it("treats only the unnamed frame as the anonymous block target itself", () => {
    // 匿名块没有名字：它自己的帧没有程序名；step-in 进去的子程序帧是「另一个对象」，
    // 正是「查看该帧源码」要覆盖的场景。
    const target = { objectType: "ANONYMOUS", objectName: null, packageName: null };
    expect(frameBelongsToTarget({ program: "" }, target)).toBe(true);
    expect(frameBelongsToTarget({ program: "DBX_DEBUG.P_DEMO" }, target)).toBe(false);
  });

  it("has no target to belong to without a session", () => {
    expect(frameBelongsToTarget({ program: "P_DEMO" }, null)).toBe(false);
    expect(frameBelongsToTarget({ program: "P_DEMO" }, { objectType: "PROCEDURE", objectName: "  ", packageName: null })).toBe(false);
  });
});
