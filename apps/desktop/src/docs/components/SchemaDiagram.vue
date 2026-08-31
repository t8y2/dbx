<script setup lang="ts">
import { computed } from "vue";
import { layoutDiagramTables } from "@/lib/diagram/erDiagram";
import { clipToCard } from "../diagramGeometry";
import type { Point } from "../diagramGeometry";
import { qualifiedTableKey } from "../docsKeys";
import { groupStyle } from "../groupColor";
import type { SchemaSnapshot } from "../types";

const props = defineProps<{
  snapshot: SchemaSnapshot;
}>();

const emit = defineEmits<{
  select: [tableKey: string];
}>();

// Mirrors layoutDiagramTables' own defaults (lib/diagram/erDiagram.ts) so the
// card geometry drawn here matches the slot the layout actually left for it.
const CARD_WIDTH = 260;
const CARD_HEIGHT = 220;
const MARGIN = 40;
const MAX_VISIBLE_COLUMNS = 8;
const HALF = { width: CARD_WIDTH / 2, height: CARD_HEIGHT / 2 };

const positions = computed(() => layoutDiagramTables(props.snapshot.tables.map((table) => ({ name: qualifiedTableKey(table), columns: table.columns }))));

const groupsById = computed(() => new Map(props.snapshot.groups.map((group) => [group.id, group])));

interface DiagramCard {
  key: string;
  x: number;
  y: number;
  hue: number | null;
  columns: string[];
}

const cards = computed<DiagramCard[]>(() =>
  props.snapshot.tables.map((table) => {
    const key = qualifiedTableKey(table);
    const position = positions.value[key] ?? { x: MARGIN, y: MARGIN };
    const group = table.groupId ? (groupsById.value.get(table.groupId) ?? null) : null;
    return {
      key,
      x: position.x,
      y: position.y,
      hue: group?.hue ?? null,
      columns: table.columns.slice(0, MAX_VISIBLE_COLUMNS).map((column) => column.name),
    };
  }),
);

function centreOf(key: string): Point {
  const position = positions.value[key] ?? { x: MARGIN, y: MARGIN };
  return { x: position.x + CARD_WIDTH / 2, y: position.y + CARD_HEIGHT / 2 };
}

interface DiagramEdge {
  id: string;
  from: Point;
  to: Point;
}

const edges = computed<DiagramEdge[]>(() => {
  const known = new Set(Object.keys(positions.value));
  return props.snapshot.relationships
    .map((relationship) => ({
      relationship,
      fromKey: qualifiedTableKey({ schema: relationship.from.schema, name: relationship.from.table }),
      toKey: qualifiedTableKey({ schema: relationship.to.schema, name: relationship.to.table }),
    }))
    .filter(({ fromKey, toKey }) => known.has(fromKey) && known.has(toKey))
    .map(({ relationship, fromKey, toKey }) => {
      const fromCentre = centreOf(fromKey);
      const toCentre = centreOf(toKey);
      return {
        id: relationship.id,
        from: clipToCard(fromCentre, toCentre, HALF),
        to: clipToCard(toCentre, fromCentre, HALF),
      };
    });
});

// Empty-diagram guard: Math.max(0, ...[]) is 0 rather than -Infinity, so a
// snapshot with no tables still produces a valid (if empty) canvas.
const svgWidth = computed(() => Math.max(0, ...cards.value.map((card) => card.x + CARD_WIDTH)) + MARGIN);
const svgHeight = computed(() => Math.max(0, ...cards.value.map((card) => card.y + CARD_HEIGHT)) + MARGIN);

/**
 * `background-color` has no effect on SVG shapes — they paint through `fill`
 * — so the group accent is the card's fill rather than a CSS background, tied
 * to the same `--group-tint`/`--h` tokens `groupStyle` drives everywhere else
 * in the viewer.
 */
function cardFillStyle(hue: number | null): Record<string, string> {
  return hue === null ? {} : { ...groupStyle(hue), fill: "var(--group-tint)" };
}
</script>

<template>
  <div class="overflow-auto">
    <svg :width="svgWidth" :height="svgHeight" :viewBox="`0 0 ${svgWidth} ${svgHeight}`" class="block">
      <line v-for="edge in edges" :key="edge.id" :x1="edge.from.x" :y1="edge.from.y" :x2="edge.to.x" :y2="edge.to.y" class="stroke-border" stroke-width="1.5" />

      <g v-for="card in cards" :key="card.key">
        <rect :x="card.x" :y="card.y" :width="CARD_WIDTH" :height="CARD_HEIGHT" rx="6" class="cursor-pointer stroke-border" :class="card.hue === null ? 'fill-card' : 'docs-group'" :style="cardFillStyle(card.hue)" stroke-width="1" @click="emit('select', card.key)" />
        <text :x="card.x + 10" :y="card.y + 22" class="pointer-events-none fill-foreground font-mono text-[11px] font-semibold">{{ card.key }}</text>
        <text v-for="(column, index) in card.columns" :key="column" :x="card.x + 10" :y="card.y + 42 + index * 18" class="pointer-events-none fill-muted-foreground font-mono text-[10px]">
          {{ column }}
        </text>
      </g>
    </svg>
  </div>
</template>
