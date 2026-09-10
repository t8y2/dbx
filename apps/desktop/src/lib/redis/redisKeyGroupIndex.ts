import type { RedisKeyInfo } from "@/lib/backend/api";
import { compileRedisKeyGroups, type RedisKeyGroupRule } from "./redisKeyGrouping";

export interface RedisVirtualGroupRow {
  kind: "virtual-group";
  id: string;
  label: string;
  depth: number;
  count: number;
}
export interface RedisGroupedKeyRow {
  kind: "key";
  id: string;
  key: RedisKeyInfo;
  label: string;
  depth: number;
}
export type RedisGroupedRow = RedisVirtualGroupRow | RedisGroupedKeyRow;
export interface RedisOuterGroupBoundary {
  start: number;
  end: number;
  row: RedisVirtualGroupRow;
}
export interface RedisHeaderBoundary extends RedisOuterGroupBoundary {
  parent?: RedisHeaderBoundary;
}

/** Header-only binary lookup plus parent links; never reads leaf rows. */
export function findRedisHeaderChain(headers: readonly RedisHeaderBoundary[], position: number): RedisHeaderBoundary[] {
  let low = 0;
  let high = headers.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (headers[mid]!.start <= position) low = mid + 1;
    else high = mid;
  }
  let header: RedisHeaderBoundary | undefined = headers[low - 1];
  const chain: RedisHeaderBoundary[] = [];
  while (header) {
    if (position < header.end) chain.push(header);
    header = header.parent;
  }
  return chain.reverse();
}

/** Only searches outer sections (at most 65), never the virtual key source. */
export function findRedisOuterGroup(groups: readonly RedisOuterGroupBoundary[], position: number): RedisOuterGroupBoundary | undefined {
  let low = 0;
  let high = groups.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const group = groups[mid]!;
    if (position < group.start) high = mid - 1;
    else if (position >= group.end) low = mid + 1;
    else return group;
  }
  return undefined;
}
interface Namespace {
  id: string;
  label: string;
  count: number;
  children: Map<string, Namespace>;
  keys: RedisKeyInfo[];
}
interface Group {
  id: string;
  label: string;
  keys: RedisKeyInfo[];
  tree?: Namespace;
  treeLength: number;
}
export interface GroupWork {
  current: () => boolean;
  yield: () => Promise<void>;
}
const CHUNK = 512;

/** Non-reactive index: ordinary append batches classify only new identities. */
export class RedisKeyGroupIndex {
  readonly groups: Group[];
  private readonly classify: ReturnType<typeof compileRedisKeyGroups>;
  private readonly byId = new Map<string | null, Group>();
  private readonly locations = new Map<string, { group: Group; offset: number; namespace?: Namespace; namespaceOffset?: number }>();
  private consumed = 0;
  private lastRaw: string | undefined;

  constructor(rules: readonly RedisKeyGroupRule[], unmatched: string) {
    this.classify = compileRedisKeyGroups(rules);
    this.groups = rules
      .filter((rule) => rule.enabled)
      .map((rule) => {
        const group = { id: `custom:${JSON.stringify(rule.id)}`, label: rule.name, keys: [], treeLength: 0 };
        this.byId.set(rule.id, group);
        return group;
      });
    const group = { id: "custom:unmatched", label: unmatched, keys: [], treeLength: 0 };
    this.byId.set(null, group);
    this.groups.push(group);
  }

  canAppend(keys: readonly RedisKeyInfo[]): boolean {
    return keys.length >= this.consumed && (!this.consumed || keys[this.consumed - 1]?.key_raw === this.lastRaw);
  }

  async append(keys: readonly RedisKeyInfo[], work: GroupWork): Promise<boolean> {
    for (let offset = this.consumed; offset < keys.length; ) {
      if (!work.current()) return false;
      const end = Math.min(offset + CHUNK, keys.length);
      for (; offset < end; offset++) {
        const key = keys[offset]!;
        if (this.locations.has(key.key_raw)) continue;
        const group = this.byId.get(this.classify(key.key_raw))!;
        this.locations.set(key.key_raw, { group, offset: group.keys.length });
        group.keys.push(key);
      }
      this.consumed = offset;
      this.lastRaw = keys[offset - 1]?.key_raw;
      if (offset < keys.length) await work.yield();
    }
    return work.current();
  }

  async project(view: "list" | "tree", separator: string, expanded: ReadonlySet<string>, work: GroupWork): Promise<{ rows: RedisGroupedRow[]; outerGroups: RedisOuterGroupBoundary[]; headerBoundaries: RedisHeaderBoundary[]; positions: { get: (id: string) => number | undefined } } | null> {
    // Row ranges reference canonical key arrays. A million-key list projection
    // is O(groups), not O(keys) per incoming batch, and only mounted leaves
    // allocate presentation objects. Captured lengths make publication atomic.
    const ranges: { start: number; length: number; row?: RedisVirtualGroupRow; keys?: readonly RedisKeyInfo[]; depth: number }[] = [];
    const headers = new Map<string, number>();
    const outerGroups: RedisOuterGroupBoundary[] = [];
    const headerBoundaries: RedisHeaderBoundary[] = [];
    const openHeaders: RedisHeaderBoundary[] = [];
    const keyRanges = new Map<string, number>();
    let length = 0;
    let units = 0;
    const checkpoint = async () => {
      if (++units % CHUNK === 0) await work.yield();
      return work.current();
    };
    const add = (row: RedisVirtualGroupRow) => {
      while (openHeaders.length && openHeaders[openHeaders.length - 1]!.row.depth >= row.depth) openHeaders.pop()!.end = length;
      const boundary = { start: length, end: length + 1, row, parent: openHeaders[openHeaders.length - 1] };
      headerBoundaries.push(boundary);
      openHeaders.push(boundary);
      headers.set(row.id, length);
      ranges.push({ start: length++, length: 1, row, depth: row.depth });
    };
    const addKeys = (id: string, keys: readonly RedisKeyInfo[], depth: number) => {
      keyRanges.set(id, length);
      if (keys.length) ranges.push({ start: length, length: keys.length, keys, depth });
      length += keys.length;
    };
    const leaf = (key: RedisKeyInfo, label: string, depth: number): RedisGroupedKeyRow => ({ kind: "key", id: `key:${key.key_raw}`, key, label, depth });
    for (const group of this.groups) {
      if (!work.current()) return null;
      if (group.id === "custom:unmatched" && !group.keys.length) continue;
      const previous = outerGroups[outerGroups.length - 1];
      if (previous) previous.end = length;
      const row: RedisVirtualGroupRow = { kind: "virtual-group", id: group.id, label: group.label, depth: 0, count: group.keys.length };
      outerGroups.push({ start: length, end: length + 1, row });
      add(row);
      if (!expanded.has(group.id)) continue;
      if (view === "list" || !separator) {
        addKeys(group.id, group.keys, 1);
      } else {
        // A namespace index is built only for an expanded outer group. It holds
        // references to canonical records, not copies of metadata.
        group.tree ??= { id: group.id, label: "", count: 0, children: new Map(), keys: [] };
        for (let i = group.treeLength; i < group.keys.length; i++) {
          const key = group.keys[i]!;
          const parts = key.key_display.split(separator);
          let node = group.tree;
          const path: string[] = [];
          node.count++;
          for (const part of parts.slice(0, -1)) {
            path.push(part);
            let child = node.children.get(part);
            if (!child) {
              child = { id: `${group.id}:namespace:${JSON.stringify(path)}`, label: part, count: 0, children: new Map(), keys: [] };
              node.children.set(part, child);
            }
            child.count++;
            node = child;
          }
          const location = this.locations.get(key.key_raw)!;
          location.namespace = node;
          location.namespaceOffset = node.keys.length;
          node.keys.push(key);
          group.treeLength = i + 1;
          if (!(await checkpoint())) return null;
        }
        const stack: { children: Iterator<Namespace>; depth: number }[] = [{ children: group.tree.children.values(), depth: 1 }];
        addKeys(group.tree.id, group.tree.keys, 1);
        while (stack.length) {
          const frame = stack[stack.length - 1]!;
          const result = frame.children.next();
          if (result.done) {
            stack.pop();
            continue;
          }
          const node = result.value;
          add({ kind: "virtual-group", id: node.id, label: node.label, depth: frame.depth, count: node.count });
          if (expanded.has(node.id)) {
            addKeys(node.id, node.keys, frame.depth + 1);
            stack.push({ children: node.children.values(), depth: frame.depth + 1 });
          }
          if (!(await checkpoint())) return null;
        }
      }
    }
    const lastGroup = outerGroups[outerGroups.length - 1];
    if (lastGroup) lastGroup.end = length;
    for (const header of openHeaders) header.end = length;
    const at = (index: number): RedisGroupedRow | undefined => {
      if (index < 0 || index >= length) return undefined;
      let low = 0;
      let high = ranges.length - 1;
      while (low <= high) {
        const mid = (low + high) >>> 1;
        const range = ranges[mid]!;
        if (index < range.start) high = mid - 1;
        else if (index >= range.start + range.length) low = mid + 1;
        else {
          if (range.row) return range.row;
          const key = range.keys![index - range.start]!;
          const parts = view === "tree" && separator ? key.key_display.split(separator) : [key.key_display];
          return leaf(key, parts[parts.length - 1] ?? "", range.depth);
        }
      }
      return undefined;
    };
    const rows = new Proxy([] as RedisGroupedRow[], {
      get(target, property, receiver) {
        if (property === "length") return length;
        const n = typeof property === "string" && /^(0|[1-9]\d*)$/.test(property) ? Number(property) : -1;
        return n >= 0 ? at(n) : Reflect.get(target, property, receiver);
      },
      has(target, property) {
        const n = typeof property === "string" && /^(0|[1-9]\d*)$/.test(property) ? Number(property) : -1;
        return n >= 0 ? n < length : Reflect.has(target, property);
      },
    });
    const positions = {
      get: (id: string) => {
        if (!id.startsWith("key:")) return headers.get(id);
        const location = this.locations.get(id.slice(4));
        if (!location) return undefined;
        const tree = view === "tree" && !!separator;
        const start = keyRanges.get(tree ? (location.namespace?.id ?? "") : location.group.id);
        return start === undefined ? undefined : start + (tree ? location.namespaceOffset! : location.offset);
      },
    };
    return work.current() ? { rows, outerGroups, headerBoundaries, positions } : null;
  }
}
