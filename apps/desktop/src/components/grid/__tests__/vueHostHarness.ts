import { createRenderer, defineComponent, h, nextTick, reactive, ref, type Component } from "vue";

export interface HostNode {
  type: string;
  props: Record<string, any>;
  children: Array<HostNode | string>;
  parent: HostNode | null;
  focused: boolean;
  selected: boolean;
  value?: unknown;
  listeners: Map<string, Array<(event: any) => void>>;
  focus(): void;
  select(): void;
  addEventListener(name: string, listener: (event: any) => void): void;
  removeEventListener(name: string, listener: (event: any) => void): void;
}

function createHostNode(type: string): HostNode {
  const node: HostNode = {
    type,
    props: {},
    children: [],
    parent: null,
    focused: false,
    selected: false,
    listeners: new Map(),
    focus() {
      node.focused = true;
    },
    select() {
      node.selected = true;
    },
    addEventListener(name, listener) {
      const listeners = node.listeners.get(name) ?? [];
      listeners.push(listener);
      node.listeners.set(name, listeners);
    },
    removeEventListener(name, listener) {
      node.listeners.set(
        name,
        (node.listeners.get(name) ?? []).filter((candidate) => candidate !== listener),
      );
    },
  };
  return node;
}

function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  child.parent = parent;
  if (!anchor) {
    parent.children.push(child);
    return;
  }
  const index = parent.children.indexOf(anchor);
  parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
}

const renderer = createRenderer<HostNode, HostNode>({
  patchProp(node, key, _previous, next) {
    if (next === null || next === undefined) delete node.props[key];
    else node.props[key] = next;
    if (key === "value") node.value = next;
  },
  insert,
  remove(node) {
    if (!node.parent) return;
    const index = node.parent.children.indexOf(node);
    if (index >= 0) node.parent.children.splice(index, 1);
    node.parent = null;
  },
  createElement: createHostNode,
  createText(text) {
    const node = createHostNode("#text");
    node.children = [text];
    return node;
  },
  createComment(text) {
    const node = createHostNode("#comment");
    node.children = [text];
    return node;
  },
  setText(node, text) {
    node.children = [text];
  },
  setElementText(node, text) {
    node.children = [text];
  },
  parentNode: (node) => node.parent,
  nextSibling(node) {
    if (!node.parent) return null;
    const index = node.parent.children.indexOf(node);
    return (node.parent.children[index + 1] as HostNode | undefined) ?? null;
  },
  setScopeId(node, id) {
    node.props[id] = "";
  },
  cloneNode(node) {
    return { ...node, props: { ...node.props }, children: [...node.children], parent: null, listeners: new Map(node.listeners) };
  },
  insertStaticContent(content, parent, anchor) {
    const node = createHostNode("#static");
    node.children = [content];
    insert(node, parent, anchor);
    return [node, node];
  },
});

export function createPassthroughStub(name: string, tag = "div") {
  return defineComponent({
    name,
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => h(tag, { ...attrs, "data-stub": name }, [slots.default?.(), slots.content?.()]);
    },
  });
}

export function mountComponent(component: Component, initialProps: Record<string, unknown>) {
  const props = reactive({ ...initialProps });
  const componentRef = ref<any>();
  const root = createHostNode("root");
  const wrapper = defineComponent({
    setup() {
      return () => h(component, { ...props, ref: componentRef });
    },
  });
  const app = renderer.createApp(wrapper);
  app.mount(root);
  return {
    root,
    exposed: componentRef,
    async setProps(patch: Record<string, unknown>) {
      Object.assign(props, patch);
      await nextTick();
    },
    unmount() {
      app.unmount();
    },
  };
}

export function findAll(node: HostNode, predicate: (node: HostNode) => boolean): HostNode[] {
  const matches: HostNode[] = [];
  if (predicate(node)) matches.push(node);
  for (const child of node.children) {
    if (typeof child !== "string") matches.push(...findAll(child, predicate));
  }
  return matches;
}

export function findOne(node: HostNode, predicate: (node: HostNode) => boolean): HostNode {
  const match = findAll(node, predicate)[0];
  if (!match) throw new Error("Expected host node was not rendered");
  return match;
}

export function hostText(node: HostNode): string {
  return node.children.map((child) => (typeof child === "string" ? child : hostText(child))).join("");
}

function eventPropName(name: string) {
  return `on${name[0].toUpperCase()}${name.slice(1)}`;
}

export function dispatch(node: HostNode, name: string, overrides: Record<string, unknown> = {}) {
  const event = {
    type: name,
    target: node,
    currentTarget: node,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      event.propagationStopped = true;
    },
    ...overrides,
  };
  if (node.props.disabled) return event;
  for (const listener of node.listeners.get(name) ?? []) listener(event);
  const handler = node.props[eventPropName(name)];
  for (const callback of Array.isArray(handler) ? handler : handler ? [handler] : []) callback(event);
  return event;
}
