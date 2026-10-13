<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowDown, ArrowUp, GripVertical } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/settingsStore";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ContextMenuItem } from "@/components/ui/customContextMenuRegistry";
import { buildSidebarMenuLayout, reorderSidebarMenuEntries, sidebarMenuActionGroup, sidebarMenuActions, sidebarMenuEntryKey, sidebarMenuPrimaryActionIds, sidebarMenuRecommendedPrimaryActionIds, type SidebarMenuScope } from "@/lib/sidebar/sidebarMenuLayout";

const props = defineProps<{ open: boolean; scope: SidebarMenuScope; items: ContextMenuItem[] }>();
const emit = defineEmits<{ "update:open": [open: boolean] }>();
const { t } = useI18n();
const settings = useSettingsStore();
const pinnedIds = ref<string[]>([]);
const hiddenIds = ref<string[]>([]);
const order = ref<string[]>([]);
const activeTab = ref("primary");
const saving = ref(false);
const error = ref("");
type Section = "primary" | "groups";
const dragging = ref<{ section: Section; key: string } | null>(null);
const dropTarget = ref<string | null>(null);
const primaryIds = computed(() => new Set(sidebarMenuPrimaryActionIds(props.scope)));
const recommendedIds = computed(() => new Set(sidebarMenuRecommendedPrimaryActionIds(props.scope)));
const choices = computed(() => {
  const seen = new Set<string>();
  return sidebarMenuActions(props.items).filter((item) => {
    const id = item.sidebarActionId;
    if (!id || seen.has(id) || sidebarMenuActionGroup(item) === "danger") return false;
    seen.add(id);
    return true;
  });
});
const groupedPreview = computed(() => buildSidebarMenuLayout(props.items, props.scope, "grouped", pinnedIds.value, t, { hiddenPrimaryIds: hiddenIds.value, order: order.value }));
const selectedChoices = computed(() => {
  const visible = new Set(choices.value.map((item) => item.sidebarActionId));
  return groupedPreview.value.filter((item) => item.sidebarActionId && visible.has(item.sidebarActionId));
});
const otherChoices = computed(() => choices.value.filter((item) => !isSelected(item.sidebarActionId!)));
const groupChoices = computed(() => groupedPreview.value.filter((item) => item.sidebarActionId?.startsWith("group.") && item.variant !== "destructive"));
const dangerGroup = computed(() => groupedPreview.value.find((item) => item.sidebarActionId === "group.danger"));

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    pinnedIds.value = [...(settings.editorSettings.sidebarMenuPinnedActions?.[props.scope] ?? [])];
    hiddenIds.value = [...(settings.editorSettings.sidebarMenuHiddenPrimaryActions?.[props.scope] ?? [])];
    order.value = [...(settings.editorSettings.sidebarMenuOrder?.[props.scope] ?? [])];
    activeTab.value = "primary";
    error.value = "";
    endDrag();
  },
  { immediate: true },
);

function isSelected(id: string) {
  return primaryIds.value.has(id) || pinnedIds.value.includes(id) || (recommendedIds.value.has(id) && !hiddenIds.value.includes(id));
}

function toggle(id: string, checked: boolean) {
  pinnedIds.value = checked ? [...new Set([...pinnedIds.value, id])] : pinnedIds.value.filter((entry) => entry !== id);
  if (recommendedIds.value.has(id)) hiddenIds.value = checked ? hiddenIds.value.filter((entry) => entry !== id) : [...new Set([...hiddenIds.value, id])];
}

function sectionItems(section: Section) {
  return section === "primary" ? selectedChoices.value : groupChoices.value;
}

function move(section: Section, from: number, to: number) {
  if (saving.value) return;
  const keys = sectionItems(section).map((item) => sidebarMenuEntryKey(item)!);
  order.value = reorderSidebarMenuEntries(order.value, keys, from, to);
}

function startDrag(event: DragEvent, section: Section, item: ContextMenuItem) {
  if (saving.value) {
    event.preventDefault();
    return;
  }
  const key = sidebarMenuEntryKey(item)!;
  dragging.value = { section, key };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", key);
  }
}

function allowDrop(event: DragEvent, section: Section, item: ContextMenuItem) {
  if (!dragging.value || dragging.value.section !== section || saving.value) return;
  event.preventDefault();
  dropTarget.value = sidebarMenuEntryKey(item)!;
}

function drop(event: DragEvent, section: Section, item: ContextMenuItem) {
  if (!dragging.value || dragging.value.section !== section || saving.value) return;
  event.preventDefault();
  const keys = sectionItems(section).map((entry) => sidebarMenuEntryKey(entry));
  move(section, keys.indexOf(dragging.value.key), keys.indexOf(sidebarMenuEntryKey(item)));
  endDrag();
}

function endDrag() {
  dragging.value = null;
  dropTarget.value = null;
}
function reset() {
  pinnedIds.value = [];
  hiddenIds.value = [];
  order.value = [];
  endDrag();
}

async function save() {
  saving.value = true;
  error.value = "";
  try {
    await settings.updateEditorSettingsAndPersist({
      sidebarMenuPinnedActions: { ...settings.editorSettings.sidebarMenuPinnedActions, [props.scope]: pinnedIds.value },
      sidebarMenuHiddenPrimaryActions: { ...settings.editorSettings.sidebarMenuHiddenPrimaryActions, [props.scope]: hiddenIds.value },
      sidebarMenuOrder: { ...settings.editorSettings.sidebarMenuOrder, [props.scope]: order.value },
    });
    emit("update:open", false);
  } catch (e) {
    error.value = t("sidebarMenu.saveFailed", { message: String(e) });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(value) => !saving && emit('update:open', value)">
    <DialogContent class="flex max-h-[90vh] flex-col sm:max-w-xl">
      <DialogHeader class="shrink-0">
        <DialogTitle>{{ t("sidebarMenu.customizeTitle", { scope: t(`sidebarMenu.scopes.${scope}`) }) }}</DialogTitle>
        <DialogDescription>{{ t("sidebarMenu.scopedDescription", { scope: t(`sidebarMenu.scopes.${scope}`) }) }}</DialogDescription>
      </DialogHeader>
      <div class="flex shrink-0 items-center justify-between gap-2">
        <Label>{{ t("sidebarMenu.primaryActions", { scope: t(`sidebarMenu.scopes.${scope}`) }) }}</Label>
        <Button variant="ghost" size="sm" :disabled="saving" @click="reset">{{ t("sidebarMenu.reset") }}</Button>
      </div>
      <Tabs v-model="activeTab" class="flex min-h-0 flex-1 flex-col">
        <TabsList class="shrink-0">
          <TabsTrigger value="primary">{{ t("sidebarMenu.primaryTab") }}</TabsTrigger>
          <TabsTrigger value="groups">{{ t("sidebarMenu.groupOrder") }}</TabsTrigger>
        </TabsList>
        <TabsContent value="primary" class="min-h-0 overflow-y-auto">
          <p class="mb-3 text-sm text-muted-foreground">{{ t("sidebarMenu.primaryHint") }}</p>
          <div class="max-h-[min(45vh,360px)] overflow-y-auto space-y-1 pr-2">
            <div
              v-for="(item, index) in selectedChoices"
              :key="item.sidebarActionId"
              :data-menu-entry="sidebarMenuEntryKey(item)"
              class="flex items-center gap-2 rounded-md px-1 py-1"
              :class="dropTarget === sidebarMenuEntryKey(item) ? 'bg-accent' : ''"
              @dragover="allowDrop($event, 'primary', item)"
              @drop="drop($event, 'primary', item)"
            >
              <Button type="button" variant="ghost" size="icon" class="size-7 shrink-0 cursor-grab" :disabled="saving" draggable="true" :aria-label="t('sidebarMenu.dragAction', { name: item.label })" @dragstart="startDrag($event, 'primary', item)" @dragend="endDrag"
                ><GripVertical class="size-4"
              /></Button>
              <Label class="flex min-w-0 flex-1 items-center gap-3 py-1">
                <input type="checkbox" class="size-4 shrink-0 accent-primary" checked :aria-label="item.label" :disabled="saving || primaryIds.has(item.sidebarActionId!)" @change="toggle(item.sidebarActionId!, ($event.target as HTMLInputElement).checked)" />
                <component :is="item.icon" v-if="item.icon" class="size-4 shrink-0 text-muted-foreground" />
                <span class="min-w-0 flex-1">{{ item.label }}</span>
              </Label>
              <span v-if="primaryIds.has(item.sidebarActionId!)" class="shrink-0 text-xs text-muted-foreground">{{ t("sidebarMenu.builtIn") }}</span>
              <span v-else-if="recommendedIds.has(item.sidebarActionId!)" class="shrink-0 text-xs text-muted-foreground">{{ t("sidebarMenu.recommended") }}</span>
              <div class="flex shrink-0">
                <Button type="button" variant="ghost" size="icon" class="size-7" :disabled="saving || index === 0" :aria-label="t('sidebarMenu.moveUp', { name: item.label })" @click="move('primary', index, index - 1)"><ArrowUp class="size-3.5" /></Button>
                <Button type="button" variant="ghost" size="icon" class="size-7" :disabled="saving || index === selectedChoices.length - 1" :aria-label="t('sidebarMenu.moveDown', { name: item.label })" @click="move('primary', index, index + 1)"><ArrowDown class="size-3.5" /></Button>
              </div>
            </div>
            <template v-if="otherChoices.length">
              <p class="px-2 pt-3 pb-1 text-xs text-muted-foreground">{{ t("sidebarMenu.otherActions") }}</p>
              <Label v-for="item in otherChoices" :key="item.sidebarActionId" class="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent">
                <input type="checkbox" class="size-4 shrink-0 accent-primary" :aria-label="item.label" :disabled="saving" @change="toggle(item.sidebarActionId!, ($event.target as HTMLInputElement).checked)" />
                <component :is="item.icon" v-if="item.icon" class="size-4 shrink-0 text-muted-foreground" />
                <span class="flex-1">{{ item.label }}</span>
                <span v-if="recommendedIds.has(item.sidebarActionId!)" class="text-xs text-muted-foreground">{{ t("sidebarMenu.recommended") }}</span>
              </Label>
            </template>
          </div>
        </TabsContent>
        <TabsContent value="groups" class="min-h-0 overflow-y-auto">
          <p class="mb-3 text-sm text-muted-foreground">{{ t("sidebarMenu.orderHint") }}</p>
          <div class="max-h-[min(45vh,360px)] overflow-y-auto space-y-1 pr-2">
            <div
              v-for="(item, index) in groupChoices"
              :key="item.sidebarActionId"
              :data-menu-entry="sidebarMenuEntryKey(item)"
              class="flex items-center gap-2 rounded-md px-1 py-1"
              :class="dropTarget === sidebarMenuEntryKey(item) ? 'bg-accent' : ''"
              @dragover="allowDrop($event, 'groups', item)"
              @drop="drop($event, 'groups', item)"
            >
              <Button type="button" variant="ghost" size="icon" class="size-7 shrink-0 cursor-grab" :disabled="saving" draggable="true" :aria-label="t('sidebarMenu.dragAction', { name: item.label })" @dragstart="startDrag($event, 'groups', item)" @dragend="endDrag"
                ><GripVertical class="size-4"
              /></Button>
              <component :is="item.icon" v-if="item.icon" class="size-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1">{{ item.label }}</span>
              <Button type="button" variant="ghost" size="icon" class="size-7" :disabled="saving || index === 0" :aria-label="t('sidebarMenu.moveUp', { name: item.label })" @click="move('groups', index, index - 1)"><ArrowUp class="size-3.5" /></Button>
              <Button type="button" variant="ghost" size="icon" class="size-7" :disabled="saving || index === groupChoices.length - 1" :aria-label="t('sidebarMenu.moveDown', { name: item.label })" @click="move('groups', index, index + 1)"><ArrowDown class="size-3.5" /></Button>
            </div>
            <div v-if="dangerGroup" class="flex items-center gap-2 px-2 py-2 text-destructive">
              <component :is="dangerGroup.icon" class="size-4" /><span class="flex-1">{{ dangerGroup.label }}</span
              ><span class="text-xs">{{ t("sidebarMenu.fixedLast") }}</span>
            </div>
          </div>
        </TabsContent>
      </Tabs>
      <p v-if="error" role="alert" class="shrink-0 text-sm text-destructive">{{ error }}</p>
      <DialogFooter class="shrink-0">
        <Button variant="outline" :disabled="saving" @click="emit('update:open', false)">{{ t("common.cancel") }}</Button>
        <Button :disabled="saving" @click="save">{{ saving ? t("common.processing") : t("common.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
