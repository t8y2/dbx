import { describe, expect, it } from "vitest";
import { createCloseAllTabMenuItem, createCloseLeftTabMenuItem, createCloseOtherTabMenuItem, createCloseRightTabMenuItem, createCloseTabMenuItem, createLocateTabMenuItem, createPinTabMenuItem, createRenameDuplicateTabItems } from "@/lib/tabs/tabMenu";

const t = (key: string) => key;

describe("shared tab menu helpers", () => {
  it("builds rename and duplicate items only when renaming is allowed", () => {
    const items = createRenameDuplicateTabItems({
      tab: { id: "t1" } as never,
      t,
      canRename: true,
      onRename: () => undefined,
      onDuplicate: () => undefined,
    });

    expect(items).toHaveLength(2);
    expect(items[0]?.label).toBe("contextMenu.renameTab");
    expect(items[1]?.label).toBe("contextMenu.duplicateTab");
    expect(items[1]?.visible).toBe(true);

    const queryOnly = createRenameDuplicateTabItems({
      tab: { id: "t2" } as never,
      t,
      canRename: false,
      onRename: () => undefined,
      onDuplicate: () => undefined,
    });
    expect(queryOnly).toHaveLength(1);
    expect(queryOnly[0]?.visible).toBe(false);
  });

  it("builds locate and pin menu items with the expected actions", () => {
    let located = false;
    let toggled = false;

    const locate = createLocateTabMenuItem({
      t,
      visible: true,
      onLocate: () => {
        located = true;
      },
    });
    locate.action?.();
    expect(located).toBe(true);
    expect(locate.label).toBe("sidebar.locateActiveTab");

    const hiddenLocate = createLocateTabMenuItem({
      t,
      visible: false,
      onLocate: () => undefined,
    });
    expect(hiddenLocate.visible).toBe(false);

    const pin = createPinTabMenuItem({
      label: "Pin",
      iconClass: "fill-current",
      onToggle: () => {
        toggled = true;
      },
    });
    pin.action?.();
    expect(toggled).toBe(true);
    expect(pin.iconClass).toBe("fill-current");

    const pinWithoutIconClass = createPinTabMenuItem({
      label: "Pin",
      onToggle: () => undefined,
    });
    expect(pinWithoutIconClass.iconClass).toBeUndefined();
  });

  it("builds close menu items with labels and actions", () => {
    let closed = false;
    const close = createCloseTabMenuItem({
      label: "Close",
      onClose: () => {
        closed = true;
      },
    });
    close.action?.();
    expect(closed).toBe(true);

    const closeOther = createCloseOtherTabMenuItem({
      label: "Close Other",
      disabled: true,
      onClose: () => undefined,
    });
    expect(closeOther.disabled).toBe(true);

    const closeOtherWithoutDisabled = createCloseOtherTabMenuItem({
      label: "Close Other",
      onClose: () => undefined,
    });
    expect("disabled" in closeOtherWithoutDisabled).toBe(false);

    const closeRight = createCloseRightTabMenuItem({
      label: "Close Right",
      disabled: false,
      onClose: () => undefined,
    });
    expect(closeRight.disabled).toBe(false);

    const closeRightWithoutDisabled = createCloseRightTabMenuItem({
      label: "Close Right",
      onClose: () => undefined,
    });
    expect("disabled" in closeRightWithoutDisabled).toBe(false);

    const closeLeft = createCloseLeftTabMenuItem({
      label: "Close Left",
      disabled: true,
      onClose: () => undefined,
    });
    expect(closeLeft.disabled).toBe(true);

    const closeLeftWithoutDisabled = createCloseLeftTabMenuItem({
      label: "Close Left",
      onClose: () => undefined,
    });
    expect("disabled" in closeLeftWithoutDisabled).toBe(false);

    const closeAll = createCloseAllTabMenuItem({
      label: "Close All",
      variant: "destructive",
      onClose: () => undefined,
    });
    expect(closeAll.variant).toBe("destructive");

    const closeAllDefault = createCloseAllTabMenuItem({
      label: "Close All",
      onClose: () => undefined,
    });
    expect(closeAllDefault.variant).toBeUndefined();
  });
});
