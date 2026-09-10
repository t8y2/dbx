<script setup lang="ts">
import { computed, markRaw, nextTick, onActivated, onDeactivated, onUnmounted, ref, shallowRef, watch } from "vue";
import { RecycleScroller } from "vue-virtual-scroller";
import { KeyRound, Trash2, Copy } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import CustomContextMenu from "@/components/ui/CustomContextMenu.vue";
import type { RedisKeyInfo } from "@/lib/backend/api";
import type { RedisKeyGrouping } from "@/lib/redis/redisKeyGrouping";
import { RedisKeyGroupIndex, type RedisGroupedRow, type RedisOuterGroupBoundary, type RedisHeaderBoundary } from "@/lib/redis/redisKeyGroupIndex";
import { redisStickyHeaders, redisStickyHeight, REDIS_GROUP_ROW_HEIGHT } from "@/lib/redis/redisStickyHeaders";
import RedisGroupHeader from "./RedisGroupHeader.vue";
import { createRedisKeyViewYield } from "@/lib/redis/redisKeyViewScheduler";

const props = defineProps<{ keys: readonly RedisKeyInfo[]; config: RedisKeyGrouping; separator: string; scope: string; structureRevision: number; selected: string | null; checked: ReadonlySet<string>; busy: boolean; metadataEpoch: number; treeAllowed?: boolean }>();
const emit = defineEmits<{ select: [RedisKeyInfo]; check: [RedisKeyInfo, MouseEvent]; delete: [RedisKeyInfo, MouseEvent]; copy: [RedisKeyInfo]; scroll: [Event]; resize: []; requestList: [] }>();
const { t } = useI18n();
const expanded = shallowRef(new Set<string>());
const working = ref(false);
const active = ref(true);
const scroller = ref<InstanceType<typeof RecycleScroller> | null>(null);
const outerGroups = shallowRef<readonly RedisOuterGroupBoundary[]>([]);
const headerBoundaries = shallowRef<readonly RedisHeaderBoundary[]>([]);
const publishedTree = ref(false);
const publishedExpanded = shallowRef<ReadonlySet<string>>(new Set());
const scrollTop = ref(0);
const viewportHeight = ref(0);
const rowHeight = REDIS_GROUP_ROW_HEIGHT;
let positions: { get: (id: string) => number | undefined } = { get: () => undefined };
let pendingHeaderAnchor: string | undefined;
const sticky = computed(() => {
  if (!active.value || treeBlocked.value) return [];
  return redisStickyHeaders(outerGroups.value, headerBoundaries.value, scrollTop.value, viewportHeight.value, publishedTree.value);
});
const stickyIds = computed(() => new Set(sticky.value.map((entry) => entry.row.id)));
function updateScroll() {
  scrollTop.value = Math.max(0, scroller.value?.getScroll().start ?? 0);
  viewportHeight.value = (scroller.value?.$el as HTMLElement | undefined)?.clientHeight ?? 0;
}
function onScroll(event: Event) {
  updateScroll();
  emit("scroll", event);
}
function onResize() {
  const anchor = firstUnobscuredRowIndex();
  updateScroll();
  positionRow(anchor);
  emit("resize");
}
function collapseSticky(id: string) {
  pendingHeaderAnchor = id;
  toggle(id);
}
function positionRow(position: number) {
  // Solve using the destination overlay, not the previous branch's height.
  // Fixed rows and at most three sticky slots bound this to four lookups.
  let target = position * rowHeight;
  for (let step = 0; step <= 3; step++) {
    target = Math.max(0, (position - step) * rowHeight);
    const occupied = redisStickyHeight(redisStickyHeaders(outerGroups.value, headerBoundaries.value, target, viewportHeight.value, publishedTree.value));
    if (target + occupied <= position * rowHeight) break;
  }
  const api = scroller.value;
  api?.scrollToItem(Math.floor(target / rowHeight), { align: "start" });
  api?.updateVisibleItems(true);
  updateScroll();
}
function focusHeader(id: string) {
  const element = scroller.value?.$el as HTMLElement | undefined;
  const header = Array.from(element?.querySelectorAll<HTMLElement>("[data-redis-group-header]") ?? []).find((node) => node.dataset.redisGroupHeader === id);
  header?.focus({ preventScroll: true });
}
async function navigateHeader(id: string) {
  const position = positions.get(id);
  if (position === undefined) return;
  positionRow(position);
  await nextTick();
  focusHeader(id);
}
function revealFocusedRow(event: FocusEvent) {
  const target = event.target as HTMLElement;
  const element = scroller.value?.$el as HTMLElement | undefined;
  if (!element || !sticky.value.length) return;
  const overlap = element.getBoundingClientRect().top + redisStickyHeight(sticky.value) - target.getBoundingClientRect().top;
  if (overlap > 0) {
    element.scrollTop = Math.max(0, element.scrollTop - overlap);
    updateScroll();
  }
}
const treeBlocked = computed(() => props.treeAllowed === false && props.config.inner_view === "tree");
function firstUnobscuredRowIndex() {
  const api = scroller.value;
  return api?.findItemIndex((api.getScroll().start ?? 0) + redisStickyHeight(sticky.value)) ?? 0;
}
defineExpose({
  getScrollElement: () => scroller.value?.$el as HTMLElement | undefined,
  getViewportAnchor: () => {
    const rowIndex = firstUnobscuredRowIndex();
    const row = source[rowIndex];
    return { rowIndex, keyRaw: row?.kind === "key" ? row.key.key_raw : undefined };
  },
});
let source: readonly RedisGroupedRow[] = [];
const rows = markRaw(
  new Proxy([] as RedisGroupedRow[], {
    get(target, property, receiver) {
      if (property === "length") return source.length;
      const index = typeof property === "string" && /^(0|[1-9]\d*)$/.test(property) ? Number(property) : -1;
      return index >= 0 ? source[index] : Reflect.get(target, property, receiver);
    },
    has(target, property) {
      const index = typeof property === "string" && /^(0|[1-9]\d*)$/.test(property) ? Number(property) : -1;
      return index >= 0 ? index < source.length : Reflect.has(target, property);
    },
  }),
);
let generation = 0;
let index: RedisKeyGroupIndex | null = null;
let signature = "";
let previousKeys: readonly RedisKeyInfo[] = [];
let previousScope = props.scope;

watch(
  [() => props.keys, () => props.config, () => props.scope, () => props.separator, () => props.structureRevision, expanded, active, treeBlocked],
  async () => {
    const currentGeneration = ++generation;
    if (props.scope !== previousScope || !active.value || treeBlocked.value) pendingHeaderAnchor = undefined;
    previousScope = props.scope;
    if (!active.value) return;
    if (treeBlocked.value) {
      working.value = false;
      return;
    }
    const current = () => currentGeneration === generation;
    const nextSignature = JSON.stringify([props.scope, props.separator, props.structureRevision, props.config.rules]);
    // A same-length structural replacement can rename a key anywhere, not just
    // at the tail. Reclassify it; ordinary append keeps the membership index.
    if (!index || nextSignature !== signature || !index.canAppend(props.keys) || (previousKeys !== props.keys && previousKeys.length === props.keys.length)) {
      index = new RedisKeyGroupIndex(props.config.rules, t("redisGrouping.unmatched"));
      signature = nextSignature;
    }
    previousKeys = props.keys;
    const building = index;
    working.value = true;
    // Cancellation checkpoints are cheap; only yield a browser task when this
    // build has exhausted its time budget. Nested timers can be throttled.
    const yieldControl = createRedisKeyViewYield();
    if (!(await building.append(props.keys, { current, yield: yieldControl }))) return;
    const snapshot = await building.project(props.config.inner_view, props.separator, expanded.value, { current, yield: yieldControl });
    if (!snapshot || !current()) return;
    const oldPosition = firstUnobscuredRowIndex();
    const headerAnchor = pendingHeaderAnchor;
    const anchorId = headerAnchor ?? source[oldPosition]?.id;
    const position = anchorId ? (snapshot.positions.get(anchorId) ?? Math.min(oldPosition, Math.max(0, snapshot.rows.length - 1))) : 0;
    source = snapshot.rows;
    outerGroups.value = snapshot.outerGroups;
    headerBoundaries.value = snapshot.headerBoundaries;
    positions = snapshot.positions;
    publishedTree.value = props.config.inner_view === "tree";
    publishedExpanded.value = new Set(expanded.value);
    pendingHeaderAnchor = undefined;
    positionRow(position);
    await nextTick();
    if (!current()) return;
    positionRow(position);
    if (headerAnchor) {
      await nextTick();
      if (!current()) return;
      focusHeader(headerAnchor);
    }
    working.value = false;
  },
  { immediate: true },
);

function toggle(id: string) {
  const next = new Set(expanded.value);
  if (!next.delete(id)) next.add(id);
  expanded.value = next;
}
onUnmounted(() => {
  generation++;
});
onActivated(() => {
  active.value = true;
});
onDeactivated(() => {
  active.value = false;
  generation++;
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" :data-metadata-epoch="metadataEpoch">
    <div v-if="treeBlocked" role="status" class="space-y-2 p-3 text-xs text-muted-foreground">
      <p>{{ t("redisGrouping.fuzzyTreeUnavailable") }}</p>
      <Button variant="outline" size="sm" @click="emit('requestList')">{{ t("redisGrouping.useList") }}</Button>
    </div>
    <template v-else>
      <p class="shrink-0 px-2 py-1 text-xs text-muted-foreground">{{ working ? t("redisGrouping.preparing") : t("redisGrouping.loadedOnly") }}</p>
      <div class="relative flex min-h-0 flex-1 flex-col overflow-hidden" data-redis-group-viewport>
        <RecycleScroller ref="scroller" class="redis-key-scroller min-h-0 flex-1" :items="rows" :item-size="rowHeight" :buffer="600" key-field="id" @scroll="onScroll" @resize="onResize" @focusin="revealFocusedRow">
          <template #default="{ item }">
            <RedisGroupHeader
              v-if="item.kind === 'virtual-group'"
              :row="item"
              :expanded="publishedExpanded.has(item.id)"
              :data-redis-group-header="item.id"
              :class="stickyIds.has(item.id) ? 'invisible' : ''"
              :tabindex="stickyIds.has(item.id) ? -1 : 0"
              :aria-hidden="stickyIds.has(item.id) ? true : undefined"
              @toggle="toggle(item.id)"
            />
            <CustomContextMenu v-else :items="[{ label: t('redis.copyKeyName'), icon: Copy, action: () => emit('copy', item.key) }]" v-slot="{ onContextMenu }">
              <div
                class="group flex h-[30px] cursor-pointer items-center gap-1 border-b px-2 text-[13px] hover:bg-accent/40"
                :class="selected === item.key.key_raw ? 'bg-accent' : checked.has(item.key.key_raw) ? 'bg-primary/10' : ''"
                :style="{ paddingLeft: `${8 + item.depth * 10}px` }"
                @click="emit('select', item.key)"
                @contextmenu="onContextMenu"
              >
                <input type="checkbox" :checked="checked.has(item.key.key_raw)" :disabled="busy" :aria-label="item.key.key_display" @click.stop="emit('check', item.key, $event)" />
                <KeyRound class="h-3 w-3 shrink-0 text-muted-foreground" /><span class="dbx-editor-font-family min-w-0 flex-1 truncate" :title="item.key.key_display">{{ item.label || t("redisGrouping.emptyKey") }}</span>
                <span class="text-xs text-muted-foreground">{{ item.key.key_type }}</span>
                <Button variant="ghost" size="icon" class="h-5 w-5 text-destructive opacity-0 group-hover:opacity-100" :disabled="busy" :aria-label="t('redis.deleteKey')" @click.stop="emit('delete', item.key, $event)"><Trash2 class="h-3 w-3" /></Button>
              </div>
            </CustomContextMenu>
          </template>
        </RecycleScroller>
        <div v-for="(entry, slot) in sticky" :key="entry.row.id" class="absolute inset-x-0 top-0 bg-background" :style="{ transform: `translateY(${entry.top}px)`, zIndex: 20 - slot }">
          <RedisGroupHeader
            :row="entry.row"
            :expanded="publishedExpanded.has(entry.row.id)"
            :navigation="publishedTree"
            :sticky-depth="slot"
            :omitted="entry.omitted"
            :path="entry.path"
            :data-redis-sticky-group="entry.row.id"
            @toggle="collapseSticky(entry.row.id)"
            @navigate="navigateHeader(entry.row.id)"
          />
        </div>
      </div>
    </template>
  </div>
</template>
