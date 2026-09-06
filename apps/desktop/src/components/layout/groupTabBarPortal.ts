import { shallowReactive, type InjectionKey, type Ref } from "vue";

export interface GroupTabBarPortal {
  active: Readonly<Ref<boolean>>;
  targets: Map<string, HTMLElement>;
}

export const GROUP_TAB_BAR_PORTAL: InjectionKey<GroupTabBarPortal> = Symbol("dbx:group-tab-bar-portal");

// Moving the existing bars preserves their grouping, search and scroll state.
export function createGroupTabBarPortal(active: Readonly<Ref<boolean>>): GroupTabBarPortal {
  return { active, targets: shallowReactive(new Map<string, HTMLElement>()) };
}
