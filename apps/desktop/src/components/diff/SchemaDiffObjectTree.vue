<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { schemaDiffObjectSelectionState, schemaDiffSelectionTargets, type SchemaDiffObject, type DiffOperationType, type DiffObjectKind, type OperationGroup } from "@/lib/schema/schemaDiff";
import { Table, Eye, FunctionSquare, ListOrdered, ScrollText, UserCog, Columns3, ListTree, Link2, Zap, SlidersHorizontal, ChevronDown, ChevronRight, ArrowRightLeft, PlusCircle, XCircle, MinusCircle } from "@lucide/vue";

const { t } = useI18n();
const expandedObjectIds = ref(new Set<string>());

const props = defineProps<{
  groups: OperationGroup[];
  selectedObjectId?: string | null;
}>();

const emit = defineEmits<{
  (e: "toggleGroup", operationType: DiffOperationType): void;
  (e: "toggleGroupSelection", operationType: DiffOperationType, selected: boolean): void;
  (e: "toggleObjectSelection", object: SchemaDiffObject, selected: boolean): void;
  (e: "selectObject", object: SchemaDiffObject): void;
}>();

const operationIcons: Record<DiffOperationType, any> = {
  modify: ArrowRightLeft,
  create: PlusCircle,
  delete: XCircle,
  none: MinusCircle,
};

const operationColors: Record<DiffOperationType, string> = {
  modify: "text-blue-500",
  create: "text-green-500",
  delete: "text-red-500",
  none: "text-muted-foreground",
};

const operationBgColors: Record<DiffOperationType, string> = {
  modify: "bg-blue-500/10 border-blue-500/20",
  create: "bg-green-500/10 border-green-500/20",
  delete: "bg-red-500/10 border-red-500/20",
  none: "bg-muted/30 border-muted",
};

function getObjectIcon(kind: DiffObjectKind) {
  switch (kind) {
    case "table":
      return Table;
    case "view":
      return Eye;
    case "function":
      return FunctionSquare;
    case "sequence":
      return ListOrdered;
    case "rule":
      return ScrollText;
    case "owner":
      return UserCog;
    case "column":
      return Columns3;
    case "index":
      return ListTree;
    case "foreignKey":
      return Link2;
    case "trigger":
      return Zap;
    case "tableOption":
      return SlidersHorizontal;
    default:
      return Table;
  }
}

function getObjectIconColor(kind: DiffObjectKind): string {
  switch (kind) {
    case "table":
      return "text-amber-500";
    case "view":
      return "text-cyan-500";
    case "function":
      return "text-purple-500";
    case "sequence":
      return "text-orange-500";
    case "rule":
      return "text-pink-500";
    case "owner":
      return "text-indigo-500";
    case "column":
      return "text-sky-500";
    case "index":
      return "text-teal-500";
    case "foreignKey":
      return "text-lime-500";
    case "trigger":
      return "text-rose-500";
    case "tableOption":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

function groupObjects(group: OperationGroup): SchemaDiffObject[] {
  return group.typeGroups.flatMap((typeGroup) => typeGroup.objects);
}

function groupSelectionState(group: OperationGroup): { checked: boolean; indeterminate: boolean } {
  const targets = groupObjects(group).flatMap(schemaDiffSelectionTargets);
  const selectedCount = targets.filter((target) => target.selected).length;
  return {
    checked: targets.length > 0 && selectedCount === targets.length,
    indeterminate: selectedCount > 0 && selectedCount < targets.length,
  };
}

function toggleObjectExpanded(objectId: string) {
  const next = new Set(expandedObjectIds.value);
  if (next.has(objectId)) next.delete(objectId);
  else next.add(objectId);
  expandedObjectIds.value = next;
}

function isObjectExpanded(objectId: string): boolean {
  return expandedObjectIds.value.has(objectId);
}

function onGroupCheckboxChange(group: OperationGroup, event: Event) {
  emit("toggleGroupSelection", group.operationType, (event.target as HTMLInputElement).checked);
}

function onObjectCheckboxChange(object: SchemaDiffObject, event: Event) {
  emit("toggleObjectSelection", object, (event.target as HTMLInputElement).checked);
}

function displayObjectName(object: SchemaDiffObject): string {
  if (object.objectKind === "tableOption") return t("diff.objectKindLabel.tableOption");
  if (object.objectKind === "function" && object.arguments) return `${object.name}(${object.arguments})`;
  return object.name;
}

function sourceObjectName(object: SchemaDiffObject): string {
  return object.sourceName ?? displayObjectName(object);
}

function targetObjectName(object: SchemaDiffObject): string {
  return object.targetName ?? displayObjectName(object);
}
</script>

<template>
  <div class="space-y-1">
    <div class="grid grid-cols-[1fr_60px_1fr] gap-2 px-2 py-1.5 text-xs font-medium text-muted-foreground border-b">
      <div class="text-center">{{ t("diff.sourceObject") }}</div>
      <div class="text-center">{{ t("diff.operation") }}</div>
      <div class="text-center">{{ t("diff.targetObject") }}</div>
    </div>

    <div v-for="group in props.groups" :key="group.operationType" class="border rounded-md overflow-hidden">
      <button class="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium transition-colors" :class="operationBgColors[group.operationType]" @click="$emit('toggleGroup', group.operationType)">
        <ChevronDown v-if="group.expanded" class="w-4 h-4 shrink-0" />
        <ChevronRight v-else class="w-4 h-4 shrink-0" />
        <input type="checkbox" class="accent-primary shrink-0" :checked="groupSelectionState(group).checked" :indeterminate="groupSelectionState(group).indeterminate" :disabled="group.count === 0" @click.stop @change="onGroupCheckboxChange(group, $event)" />
        <component :is="operationIcons[group.operationType]" class="w-4 h-4 shrink-0" :class="operationColors[group.operationType]" />
        <span :class="operationColors[group.operationType]">{{ t(group.label) }}</span>
        <span class="text-xs text-muted-foreground ml-1">({{ t("diff.selectedCount", { selected: group.selectedCount, total: group.count }) }})</span>
      </button>

      <div v-if="group.expanded" class="divide-y divide-border/30">
        <div v-for="object in groupObjects(group)" :key="object.id">
          <div class="grid grid-cols-[1fr_60px_1fr] gap-2 px-3 py-1.5 items-center hover:bg-accent/30 cursor-pointer" :class="{ 'bg-primary/10': selectedObjectId === object.id }" @click="$emit('selectObject', object)">
            <div v-if="object.operationType !== 'delete'" class="flex items-center gap-2 min-w-0 pl-6">
              <button v-if="object.children?.length" type="button" class="shrink-0" @click.stop="toggleObjectExpanded(object.id)">
                <ChevronDown v-if="isObjectExpanded(object.id)" class="w-3.5 h-3.5" />
                <ChevronRight v-else class="w-3.5 h-3.5" />
              </button>
              <span v-else class="w-3.5 shrink-0" />
              <input type="checkbox" class="accent-primary shrink-0" :checked="schemaDiffObjectSelectionState(object).checked" :indeterminate="schemaDiffObjectSelectionState(object).indeterminate" @click.stop @change="onObjectCheckboxChange(object, $event)" />
              <component :is="getObjectIcon(object.objectKind)" class="w-3.5 h-3.5 shrink-0" :class="getObjectIconColor(object.objectKind)" />
              <span class="text-xs truncate" :class="object.operationType === 'create' ? 'text-green-500' : ''">{{ sourceObjectName(object) }}</span>
              <span v-if="object.children?.length" class="text-[10px] text-muted-foreground shrink-0">{{ schemaDiffSelectionTargets(object).filter((child) => child.selected).length }}/{{ schemaDiffSelectionTargets(object).length }}</span>
            </div>
            <div v-else />

            <div class="flex justify-center">
              <component :is="operationIcons[object.operationType]" class="w-3.5 h-3.5" :class="operationColors[object.operationType]" />
            </div>

            <div v-if="object.operationType !== 'create'" class="flex items-center gap-2 min-w-0 pl-6">
              <button v-if="object.operationType === 'delete' && object.children?.length" type="button" class="shrink-0" @click.stop="toggleObjectExpanded(object.id)">
                <ChevronDown v-if="isObjectExpanded(object.id)" class="w-3.5 h-3.5" />
                <ChevronRight v-else class="w-3.5 h-3.5" />
              </button>
              <span v-else-if="object.operationType === 'delete'" class="w-3.5 shrink-0" />
              <input
                v-if="object.operationType === 'delete'"
                type="checkbox"
                class="accent-primary shrink-0"
                :checked="schemaDiffObjectSelectionState(object).checked"
                :indeterminate="schemaDiffObjectSelectionState(object).indeterminate"
                @click.stop
                @change="onObjectCheckboxChange(object, $event)"
              />
              <component :is="getObjectIcon(object.objectKind)" class="w-3.5 h-3.5 shrink-0" :class="getObjectIconColor(object.objectKind)" />
              <span class="text-xs truncate" :class="object.operationType === 'delete' ? 'text-red-500 line-through' : ''">{{ targetObjectName(object) }}</span>
              <span v-if="object.children?.length" class="text-[10px] text-muted-foreground shrink-0">{{ schemaDiffSelectionTargets(object).filter((child) => child.selected).length }}/{{ schemaDiffSelectionTargets(object).length }}</span>
            </div>
            <div v-else />
          </div>

          <div v-if="object.children?.length && isObjectExpanded(object.id)" class="border-t border-border/20 bg-muted/10">
            <div v-for="child in object.children" :key="child.id" class="grid grid-cols-[1fr_60px_1fr] gap-2 px-3 py-1 items-center hover:bg-accent/30 cursor-pointer" :class="{ 'bg-primary/10': selectedObjectId === child.id }" @click="$emit('selectObject', child)">
              <div v-if="child.operationType !== 'delete'" class="flex items-center gap-2 min-w-0 pl-16">
                <input type="checkbox" class="accent-primary shrink-0" :checked="child.selected" @click.stop @change="onObjectCheckboxChange(child, $event)" />
                <component :is="getObjectIcon(child.objectKind)" class="w-3.5 h-3.5 shrink-0" :class="getObjectIconColor(child.objectKind)" />
                <span class="text-xs truncate">{{ sourceObjectName(child) }}</span>
              </div>
              <div v-else />
              <div class="flex justify-center">
                <component :is="operationIcons[child.operationType]" class="w-3.5 h-3.5" :class="operationColors[child.operationType]" />
              </div>
              <div v-if="child.operationType !== 'create'" class="flex items-center gap-2 min-w-0 pl-16">
                <input v-if="child.operationType === 'delete'" type="checkbox" class="accent-primary shrink-0" :checked="child.selected" @click.stop @change="onObjectCheckboxChange(child, $event)" />
                <component :is="getObjectIcon(child.objectKind)" class="w-3.5 h-3.5 shrink-0" :class="getObjectIconColor(child.objectKind)" />
                <span class="text-xs truncate" :class="child.operationType === 'delete' ? 'text-red-500 line-through' : ''">{{ targetObjectName(child) }}</span>
              </div>
              <div v-else />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
