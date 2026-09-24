<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { IntentionAction } from "@/lib/editor/sqlIntentionActions";
import type { IntentionPopupState } from "./useQueryEditorIntentions";

defineProps<{ state: IntentionPopupState | null }>();
const emit = defineEmits<{ close: []; confirm: [action: IntentionAction]; select: [index: number] }>();
const { t } = useI18n();

function getIntentionActionLabel(kind: string): string {
  switch (kind) {
    case "expand_wildcard":
      return t("intentionExpandWildcard");
    case "qualify_identifier":
      return t("intentionQualifyIdentifier");
    case "unqualify_identifier":
      return t("intentionUnqualifyIdentifier");
    case "batch_qualify_identifiers":
      return t("intentionBatchQualifyIdentifiers");
    default:
      return kind;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="state?.visible" class="intention-popup-overlay" @click.self="emit('close')">
      <div class="intention-popup" :style="{ left: state.position.x + 'px', top: state.position.y + 'px' }">
        <div v-for="(action, index) in state.actions" :key="index" class="intention-popup-item" :class="{ 'intention-popup-item--active': index === state.selectedIndex }" @click="emit('confirm', action)" @mouseenter="emit('select', index)">
          <span class="intention-popup-item__icon">💡</span>
          <span class="intention-popup-item__label">{{ action.label || getIntentionActionLabel(action.kind) }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style>
.intention-popup-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: transparent;
}

.intention-popup {
  position: fixed;
  z-index: 10000;
  min-width: 220px;
  max-width: 360px;
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  padding: 4px 0;
  overflow: hidden;
}

.intention-popup-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  color: var(--foreground);
  font-size: 13px;
  line-height: 1.5;
  transition: background 0.1s;
}

.intention-popup-item:hover,
.intention-popup-item--active {
  background: var(--accent);
  color: var(--accent-foreground);
}

.intention-popup-item__icon {
  font-size: 14px;
  flex-shrink: 0;
}

.intention-popup-item__label {
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}
</style>
