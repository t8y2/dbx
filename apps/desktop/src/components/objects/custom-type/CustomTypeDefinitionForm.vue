<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { newAttributeDraft, newConstraintDraft, newEnumValueDraft, supportsOperation } from "@/lib/database/customTypeDraft";
import type { CustomTypeAttributeDraft, CustomTypeDomainConstraintDraft, CustomTypeDraftDefinition, CustomTypeEnumValueDraft, CustomTypeKind, CustomTypeManagementCapabilities } from "@/types/database";

/**
 * The kind-specific half of the designer.
 *
 * Every mutation replaces the whole definition object rather than poking at a
 * nested field, so the parent's `v-model:definition` sees one clear update and
 * the diff the planner performs is always computed from a consistent object.
 */

const props = defineProps<{
  disabled?: boolean;
  kind: CustomTypeKind;
  capabilities: CustomTypeManagementCapabilities | null;
  isCreate: boolean;
  originalDefinition?: CustomTypeDraftDefinition;
  dataTypeOptions: string[];
}>();

const model = defineModel<CustomTypeDraftDefinition>("definition", { required: true });
const definition = computed({
  get: () => model.value,
  set: (value: CustomTypeDraftDefinition) => {
    if (!props.disabled) model.value = value;
  },
});
const { t } = useI18n();

/**
 * The shared Input component types its model value as `string | number`, but
 * every field this form edits is textual. Normalizing here keeps the coercion
 * out of each template expression.
 */
function asText(value: string | number | null | undefined): string {
  return value == null ? "" : String(value);
}

const enumValues = computed(() => (definition.value.kind === "enum" ? definition.value.values : []));
const attributes = computed(() => (definition.value.kind === "composite" ? definition.value.attributes : []));
const constraints = computed(() => (definition.value.kind === "domain" ? definition.value.constraints : []));
const validatedConstraintNames = computed(() => new Set(props.originalDefinition?.kind === "domain" ? props.originalDefinition.constraints.filter((constraint) => constraint.validated === true).map((constraint) => constraint.name) : []));

function wasConstraintValidated(constraint: CustomTypeDomainConstraintDraft): boolean {
  return !props.isCreate && constraint.originalName != null && validatedConstraintNames.value.has(constraint.originalName);
}

function setEnumValues(values: CustomTypeEnumValueDraft[]) {
  if (definition.value.kind !== "enum") return;
  definition.value = { kind: "enum", values };
}

function setAttributes(next: CustomTypeAttributeDraft[]) {
  if (definition.value.kind !== "composite") return;
  definition.value = { kind: "composite", attributes: next };
}

function setConstraints(next: CustomTypeDomainConstraintDraft[]) {
  if (definition.value.kind !== "domain") return;
  definition.value = { ...definition.value, constraints: next };
}

// --- Enum ------------------------------------------------------------------

function addEnumValue(afterIndex: number | null) {
  const next = [...enumValues.value];
  const entry = newEnumValueDraft();
  if (afterIndex == null) next.push(entry);
  else next.splice(afterIndex + 1, 0, entry);
  setEnumValues(next);
}

function removeEnumValue(index: number) {
  const next = [...enumValues.value];
  if (next[index]?.originalValue != null) return;
  next.splice(index, 1);
  setEnumValues(next);
}

function moveEnumValue(index: number, delta: number) {
  const next = [...enumValues.value];
  const target = index + delta;
  if (target < 0 || target >= next.length) return;
  // Only a value that does not exist yet may move: existing labels keep their
  // relative order because PostgreSQL cannot reorder them.
  if (next[index]?.originalValue != null) return;
  const [entry] = next.splice(index, 1);
  next.splice(target, 0, entry!);
  setEnumValues(next);
}

function updateEnumValue(index: number, value: string) {
  const next = enumValues.value.map((entry, current) => (current === index ? { ...entry, value } : entry));
  setEnumValues(next);
}

// --- Composite -------------------------------------------------------------

function addAttribute() {
  setAttributes([...attributes.value, newAttributeDraft()]);
}

function removeAttribute(index: number) {
  setAttributes(attributes.value.filter((_, current) => current !== index));
}

function updateAttribute(index: number, patch: Partial<CustomTypeAttributeDraft>) {
  setAttributes(attributes.value.map((entry, current) => (current === index ? { ...entry, ...patch } : entry)));
}

// --- Domain ----------------------------------------------------------------

function addConstraint() {
  setConstraints([...constraints.value, newConstraintDraft()]);
}

function removeConstraint(index: number) {
  setConstraints(constraints.value.filter((_, current) => current !== index));
}

function updateConstraint(index: number, patch: Partial<CustomTypeDomainConstraintDraft>) {
  setConstraints(constraints.value.map((entry, current) => (current === index ? { ...entry, ...patch } : entry)));
}

const canAddEnumValue = computed(() => props.isCreate || supportsOperation(props.capabilities, "alter.enum.addValue"));
const canRenameEnumValue = computed(() => props.isCreate || supportsOperation(props.capabilities, "alter.enum.renameValue"));
const canDropAttribute = computed(() => props.isCreate || supportsOperation(props.capabilities, "alter.composite.dropAttribute"));
const canAlterAttributeType = computed(() => props.isCreate || supportsOperation(props.capabilities, "alter.composite.alterAttributeType"));
</script>

<template>
  <fieldset :disabled="disabled" class="m-0 min-h-0 min-w-0 border-0 p-0">
    <!-- Enum -->
    <div v-if="kind === 'enum'" class="flex min-h-0 flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-muted-foreground">{{ enumValues.length }}</span>
        <Button v-if="canAddEnumValue" variant="ghost" size="sm" class="h-6 px-2 text-xs" @click="addEnumValue(null)">
          <Plus class="h-3 w-3" />
        </Button>
      </div>
      <div class="min-h-0 flex-1 overflow-auto rounded-md border">
        <div v-for="(entry, index) in enumValues" :key="`${entry.originalValue ?? 'new'}-${index}`" class="flex items-center gap-2 border-b border-border/60 px-2 py-1 last:border-b-0">
          <span class="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{{ index + 1 }}</span>
          <Input class="h-7 flex-1 font-mono text-xs" :model-value="entry.value" :disabled="entry.originalValue != null && !canRenameEnumValue" :aria-label="`enum value ${index + 1}`" @update:model-value="updateEnumValue(index, asText($event))" />
          <span v-if="entry.originalValue != null" class="shrink-0 rounded border border-border px-1 py-px text-[10px] text-muted-foreground">{{ t("customType.editor.existingValue") }}</span>
          <template v-if="entry.originalValue == null">
            <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" :disabled="index === 0" @click="moveEnumValue(index, -1)">
              <ArrowUp class="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" :disabled="index === enumValues.length - 1" @click="moveEnumValue(index, 1)">
              <ArrowDown class="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" @click="removeEnumValue(index)">
              <Trash2 class="h-3 w-3" />
            </Button>
          </template>
        </div>
        <div v-if="enumValues.length === 0" class="px-3 py-4 text-center text-xs text-muted-foreground">
          {{ t("customType.editor.enumEmpty") }}
        </div>
      </div>
    </div>

    <!-- Composite -->
    <div v-else-if="kind === 'composite'" class="flex min-h-0 flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-muted-foreground">{{ attributes.length }}</span>
        <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" @click="addAttribute">
          <Plus class="h-3 w-3" />
        </Button>
      </div>
      <div class="min-h-0 flex-1 overflow-auto rounded-md border">
        <div class="flex items-center gap-2 border-b bg-muted/40 px-2 py-1 text-[11px] font-medium text-muted-foreground">
          <span class="w-5 shrink-0 text-right">#</span>
          <span class="w-40 shrink-0">{{ t("customType.members.name") }}</span>
          <span class="flex-1">{{ t("customType.members.type") }}</span>
          <span class="flex-1">{{ t("customType.members.comment") }}</span>
          <span class="w-6 shrink-0" />
        </div>
        <div v-for="(attribute, index) in attributes" :key="`${attribute.originalName ?? 'new'}-${index}`" class="flex items-center gap-2 border-b border-border/60 px-2 py-1 last:border-b-0">
          <span class="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{{ index + 1 }}</span>
          <Input class="h-7 w-40 shrink-0 font-mono text-xs" :model-value="attribute.name" :aria-label="`attribute ${index + 1} name`" @update:model-value="updateAttribute(index, { name: asText($event) })" />
          <Input
            class="h-7 min-w-0 flex-1 font-mono text-xs"
            list="dbx-custom-type-data-types"
            :model-value="attribute.dataType"
            :disabled="attribute.originalName != null && !canAlterAttributeType"
            :aria-label="`attribute ${index + 1} type`"
            @update:model-value="updateAttribute(index, { dataType: asText($event) })"
          />
          <Input class="h-7 min-w-0 flex-1 text-xs" :model-value="attribute.comment ?? ''" :aria-label="`attribute ${index + 1} comment`" @update:model-value="updateAttribute(index, { comment: asText($event) || null })" />
          <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" :disabled="attribute.originalName != null && !canDropAttribute" :title="attribute.originalName == null ? t('common.delete') : t('customType.editor.dropAttributeHint')" @click="removeAttribute(index)">
            <Trash2 class="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>

    <!-- Domain -->
    <div v-else-if="kind === 'domain' && definition.kind === 'domain'" class="flex min-h-0 flex-col gap-3 overflow-auto">
      <div class="grid grid-cols-[9rem_1fr] items-center gap-2">
        <span class="text-xs text-muted-foreground">{{ t("customType.properties.baseType") }}</span>
        <Input class="h-7 font-mono text-xs" list="dbx-custom-type-data-types" :model-value="definition.baseType" :disabled="!isCreate" :title="isCreate ? '' : t('customType.editor.baseTypeImmutable')" @update:model-value="definition = { ...definition, baseType: asText($event) }" />
        <span class="text-xs text-muted-foreground">{{ t("customType.properties.collation") }}</span>
        <Input class="h-7 font-mono text-xs" :model-value="definition.collation ?? ''" :disabled="!isCreate" :title="isCreate ? '' : t('customType.editor.collationImmutable')" @update:model-value="definition = { ...definition, collation: asText($event) || null }" />
        <span class="text-xs text-muted-foreground">{{ t("customType.properties.default") }}</span>
        <Input class="h-7 font-mono text-xs" :model-value="definition.default ?? ''" @update:model-value="definition = { ...definition, default: asText($event) || null }" />
        <span class="text-xs text-muted-foreground">{{ t("customType.properties.notNull") }}</span>
        <div class="flex items-center gap-2">
          <Switch :model-value="definition.notNull" @update:model-value="definition = { ...definition, notNull: $event === true }" />
          <span v-if="definition.notNull" class="text-[11px] text-amber-600 dark:text-amber-400">{{ t("customType.editor.notNullWarning") }}</span>
        </div>
      </div>

      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-muted-foreground">{{ t("customType.properties.domainConstraint") }}</span>
        <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" @click="addConstraint">
          <Plus class="h-3 w-3" />
        </Button>
      </div>
      <div class="rounded-md border">
        <div v-for="(constraint, index) in constraints" :key="`${constraint.originalName ?? 'new'}-${index}`" class="flex flex-col gap-1 border-b border-border/60 px-2 py-1.5 last:border-b-0">
          <div class="flex items-center gap-2">
            <Input class="h-7 w-44 shrink-0 font-mono text-xs" :model-value="constraint.name" :placeholder="t('customType.editor.constraintName')" :aria-label="`constraint ${index + 1} name`" @update:model-value="updateConstraint(index, { name: asText($event) })" />
            <!-- Only validation already saved on the server is irreversible;
                 toggling it in the draft must remain reversible until save. -->
            <label class="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground" :title="wasConstraintValidated(constraint) ? t('customType.editor.constraintAlreadyValidated') : ''">
              <input type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="constraint.validated !== false" :disabled="wasConstraintValidated(constraint)" @change="updateConstraint(index, { validated: ($event.target as HTMLInputElement).checked })" />
              {{ t("customType.editor.constraintValidated") }}
            </label>
            <span class="flex-1" />
            <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" @click="removeConstraint(index)">
              <Trash2 class="h-3 w-3" />
            </Button>
          </div>
          <Input class="h-7 font-mono text-xs" :model-value="constraint.expression" placeholder="VALUE ~ '.+@.+'" :aria-label="`constraint ${index + 1} expression`" @update:model-value="updateConstraint(index, { expression: asText($event) })" />
        </div>
        <div v-if="constraints.length === 0" class="px-3 py-3 text-center text-xs text-muted-foreground">{{ t("customType.properties.empty") }}</div>
      </div>
    </div>

    <!-- Range -->
    <div v-else-if="kind === 'range' && definition.kind === 'range'" class="flex min-h-0 flex-col gap-3 overflow-auto">
      <div class="grid grid-cols-[9rem_1fr] items-center gap-2">
        <span class="text-xs text-muted-foreground">subtype</span>
        <Input class="h-7 font-mono text-xs" list="dbx-custom-type-data-types" :model-value="definition.subtype" :disabled="!isCreate" @update:model-value="definition = { ...definition, subtype: asText($event) }" />
        <span class="text-xs text-muted-foreground">subtype_opclass</span>
        <Input class="h-7 font-mono text-xs" :model-value="definition.subtypeOpclass ?? ''" :disabled="!isCreate" @update:model-value="definition = { ...definition, subtypeOpclass: asText($event) || null }" />
        <span class="text-xs text-muted-foreground">canonical</span>
        <Input class="h-7 font-mono text-xs" :model-value="definition.canonicalFunction ?? ''" :disabled="!isCreate" @update:model-value="definition = { ...definition, canonicalFunction: asText($event) || null }" />
        <span class="text-xs text-muted-foreground">subtype_diff</span>
        <Input class="h-7 font-mono text-xs" :model-value="definition.subtypeDiffFunction ?? ''" :disabled="!isCreate" @update:model-value="definition = { ...definition, subtypeDiffFunction: asText($event) || null }" />
        <span class="text-xs text-muted-foreground">multirange_type_name</span>
        <Input class="h-7 font-mono text-xs" :model-value="definition.multirangeName ?? ''" :disabled="!isCreate" @update:model-value="definition = { ...definition, multirangeName: asText($event) || null }" />
      </div>
      <p v-if="!isCreate" class="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
        {{ t("customType.editor.rangeImmutable") }}
      </p>
    </div>

    <!-- Kinds with no structured fields (base, multirange): only the generic
         properties above are editable. -->
    <div v-else class="flex flex-col gap-2">
      <p v-if="definition.kind === 'none'" class="rounded-md border border-border bg-muted/20 px-2 py-1.5 text-[11px] text-muted-foreground">
        {{ definition.typeKind === "multirange" ? t("customType.editor.multirangeReadOnly") : t("customType.editor.noStructuralEditor") }}
      </p>
      <p v-else class="text-[11px] text-muted-foreground">{{ t("customType.editor.noStructuralEditor") }}</p>
    </div>

    <datalist id="dbx-custom-type-data-types">
      <option v-for="option in props.dataTypeOptions" :key="option" :value="option" />
    </datalist>
  </fieldset>
</template>
