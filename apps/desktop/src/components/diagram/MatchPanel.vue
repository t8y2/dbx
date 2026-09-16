<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, X, Trash2, Zap } from "@lucide/vue";
import type { InferredRelationship } from "@/types/diagram";
import { cardinalityPairFromChoice, type CardinalityChoice, type CardinalityPair } from "@/lib/diagram/cardinality";

const DEFAULT_CHOICE: CardinalityChoice = "many-to-one";

const { t } = useI18n();

const props = defineProps<{
  relationships: InferredRelationship[];
  conflicts: InferredRelationship[];
  pending: InferredRelationship[];
  confirmedIds: string[];
  ignoredIds: string[];
}>();

const emit = defineEmits<{
  (e: "confirm", payload: { id: string } & CardinalityPair): void;
  (e: "ignore", id: string): void;
  (e: "confirm-all", payload: Array<{ id: string } & CardinalityPair>): void;
  (e: "ignore-all"): void;
  (e: "clear-all"): void;
}>();

/** Per-row cardinality selection; defaults to N:1 */
const cardinalityById = reactive<Record<string, CardinalityChoice>>({});

watch(
  () => props.relationships.map((r) => r.id).join(","),
  () => {
    for (const rel of props.relationships) {
      if (!cardinalityById[rel.id]) {
        cardinalityById[rel.id] = DEFAULT_CHOICE;
      }
    }
  },
  { immediate: true },
);

const isConfirmed = (id: string) => props.confirmedIds.includes(id);
const isIgnored = (id: string) => props.ignoredIds.includes(id);

const confidenceBadge = (confidence: string) => {
  if (confidence === "high") return { class: "bg-green-100 text-green-800", text: t("diagram.confidenceHigh") };
  if (confidence === "medium") return { class: "bg-amber-100 text-amber-800", text: t("diagram.confidenceMedium") };
  return { class: "bg-red-100 text-red-800", text: t("diagram.confidenceLow") };
};

const relationshipTitle = (relationship: InferredRelationship) => {
  return `${relationship.sourceTable}.${relationship.sourceColumn} -> ${relationship.targetTable}.${relationship.targetColumn}`;
};

const confidenceOrder = { high: 2, medium: 1, low: 0 };
const sortedRelationships = computed(() => {
  return [...props.relationships].sort((a, b) => {
    if (isConfirmed(a.id) !== isConfirmed(b.id)) return isConfirmed(a.id) ? -1 : 1;
    if (isIgnored(a.id) !== isIgnored(b.id)) return isIgnored(a.id) ? 1 : -1;
    return (confidenceOrder[b.confidence] || 0) - (confidenceOrder[a.confidence] || 0);
  });
});

function choiceFor(id: string): CardinalityChoice {
  return cardinalityById[id] ?? DEFAULT_CHOICE;
}

function emitConfirm(id: string) {
  emit("confirm", { id, ...cardinalityPairFromChoice(choiceFor(id)) });
}

function emitConfirmAll() {
  const payload = props.pending.map((rel) => ({
    id: rel.id,
    ...cardinalityPairFromChoice(choiceFor(rel.id)),
  }));
  emit("confirm-all", payload);
}
</script>

<template>
  <div class="flex h-full min-w-0 flex-col overflow-hidden">
    <div class="shrink-0 border-b border-border px-3 py-2">
      <p class="mb-2 text-[11px] text-muted-foreground">{{ t("diagram.matchPickCardinality") }}</p>
      <div class="mb-2 flex min-w-0 items-center justify-between">
        <div class="flex min-w-0 flex-wrap items-center gap-1">
          <Badge variant="secondary" class="h-5 px-2 text-xs"> {{ relationships.length }} {{ t("diagram.total") }} </Badge>
          <Badge variant="default" class="h-5 px-2 text-xs"> {{ confirmedIds.length }} {{ t("diagram.confirmed") }} </Badge>
          <Badge variant="outline" class="h-5 px-2 text-xs"> {{ pending.length }} {{ t("diagram.pending") }} </Badge>
          <Badge v-if="conflicts.length > 0" variant="destructive" class="h-5 px-2 text-xs"> {{ conflicts.length }} {{ t("diagram.conflicts") }} </Badge>
        </div>
      </div>
      <div class="flex min-w-0 items-center gap-1.5">
        <Button variant="outline" size="sm" class="h-7 min-w-0 flex-1 truncate px-2 text-xs" :disabled="pending.length === 0" @click="emitConfirmAll">
          <Check class="mr-1 h-3 w-3 shrink-0" />
          <span class="truncate">{{ t("diagram.confirmAll") }}</span>
        </Button>
        <Button variant="outline" size="sm" class="h-7 min-w-0 flex-1 truncate px-2 text-xs" :disabled="pending.length === 0" @click="emit('ignore-all')">
          <X class="mr-1 h-3 w-3 shrink-0" />
          <span class="truncate">{{ t("diagram.ignoreAll") }}</span>
        </Button>
        <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" :disabled="confirmedIds.length === 0 && ignoredIds.length === 0" :title="t('diagram.clearAll')" @click="emit('clear-all')">
          <Trash2 class="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>

    <div class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-2">
      <div v-if="relationships.length === 0" class="flex flex-col items-center justify-center py-8 text-xs text-muted-foreground">
        <Zap class="mb-2 h-5 w-5" />
        <span>{{ t("diagram.noInferred") }}</span>
      </div>
      <div v-else class="flex min-w-0 flex-col gap-1">
        <div
          v-for="relationship in sortedRelationships"
          :key="relationship.id"
          class="flex min-w-0 items-stretch gap-2 rounded-md border p-2 text-xs transition-all hover:bg-muted/50"
          :class="[
            isConfirmed(relationship.id) ? 'border-primary/30 bg-primary/5' : '',
            isIgnored(relationship.id) ? 'border-border opacity-50' : '',
            props.conflicts.includes(relationship) && !isConfirmed(relationship.id) && !isIgnored(relationship.id) ? 'border-red-400/50 bg-red-50/50' : '',
            !isConfirmed(relationship.id) && !isIgnored(relationship.id) && !props.conflicts.includes(relationship) ? 'border-border hover:border-muted-foreground/50' : '',
          ]"
          :title="`${relationshipTitle(relationship)}\nConfidence: ${relationship.confidence}\nStrategy: ${relationship.strategy}`"
        >
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <div class="flex min-w-0 items-center gap-1.5">
              <Badge :class="confidenceBadge(relationship.confidence).class" class="h-4 shrink-0 px-1.5 text-[10px]">
                {{ confidenceBadge(relationship.confidence).text }}
              </Badge>
              <span class="min-w-0 flex-1 truncate font-mono text-[11px]" :title="`${relationship.sourceTable}.${relationship.sourceColumn}`"> {{ relationship.sourceTable }}.{{ relationship.sourceColumn }} </span>
            </div>
            <Select v-if="!isConfirmed(relationship.id) && !isIgnored(relationship.id)" :model-value="choiceFor(relationship.id)" @update:model-value="(value: any) => (cardinalityById[relationship.id] = String(value) as CardinalityChoice)">
              <SelectTrigger class="h-7 w-full text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="one-to-one">{{ t("diagram.cardinalityOneToOne") }}</SelectItem>
                <SelectItem value="one-to-many">{{ t("diagram.cardinalityOneToMany") }}</SelectItem>
                <SelectItem value="many-to-one">{{ t("diagram.cardinalityManyToOne") }}</SelectItem>
                <SelectItem value="many-to-many">{{ t("diagram.cardinalityManyToMany") }}</SelectItem>
              </SelectContent>
            </Select>
            <div v-else class="text-center text-[10px] text-muted-foreground">↓</div>
            <span class="min-w-0 truncate font-mono text-[11px]" :title="`${relationship.targetTable}.${relationship.targetColumn}`"> {{ relationship.targetTable }}.{{ relationship.targetColumn }} </span>
          </div>
          <div v-if="!isConfirmed(relationship.id) && !isIgnored(relationship.id)" class="flex shrink-0 flex-col justify-between">
            <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('diagram.ignoreMatch')" @click="emit('ignore', relationship.id)">
              <X class="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
            <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('diagram.confirmMatch')" @click="emitConfirm(relationship.id)">
              <Check class="h-3.5 w-3.5 text-green-600" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
