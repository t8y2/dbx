<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { FocusOutsideEvent, PointerDownOutsideEvent } from "reka-ui";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    values: string[];
    nullable?: boolean;
    initialNull?: boolean;
    cellLayout?: "grid" | "transpose";
  }>(),
  {
    nullable: false,
    initialNull: false,
    cellLayout: "grid",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  commit: [value?: string | null];
  cancel: [];
}>();

const { t } = useI18n();

const open = ref(true);
const triggerRef = ref<HTMLButtonElement | null>(null);
let closeHandled = false;

const triggerClass = computed(() => ["cell-edit-input absolute inset-0 z-10 flex items-center gap-1 border-2 border-primary bg-background py-0 text-left text-xs outline-none", props.cellLayout === "transpose" ? "px-1.5" : "px-2.5"].join(" "));

const displayValue = computed(() => {
  if (props.initialNull && props.modelValue === "") return t("grid.nullValue");
  return props.modelValue === "" ? "''" : props.modelValue;
});

onMounted(() => {
  nextTick(() => triggerRef.value?.focus());
});

function selectValue(value: string | null) {
  if (value !== null) emit("update:modelValue", value);
  finishCommit(value);
}

function finishCommit(value?: string | null) {
  closeHandled = true;
  emit("commit", value);
}

function finishCancel() {
  closeHandled = true;
  emit("cancel");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    event.preventDefault();
    finishCommit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    finishCancel();
  }
}

function onPopoverInteractOutside(event: PointerDownOutsideEvent | FocusOutsideEvent) {
  const originalEvent = event.detail.originalEvent;
  if (originalEvent instanceof FocusEvent) {
    event.preventDefault();
    return;
  }
  finishCommit();
}
</script>

<template>
  <Popover
    :open="open"
    @update:open="
      (v) => {
        open = v;
        if (!v && !closeHandled) finishCommit();
      }
    "
  >
    <PopoverTrigger as-child>
      <button ref="triggerRef" type="button" :class="triggerClass" @keydown.stop="onKeydown" @click.stop>
        <span class="min-w-0 flex-1 truncate">{{ displayValue }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" side="bottom" class="w-auto min-w-[120px] rounded-md p-1" @click.stop @keydown.stop="onKeydown" @interact-outside="onPopoverInteractOutside">
      <div class="flex flex-col gap-0.5">
        <button v-if="nullable" type="button" class="flex min-h-7 w-full items-center rounded-sm px-2 py-1 text-left text-xs italic text-muted-foreground hover:bg-accent hover:text-accent-foreground" :class="{ 'bg-accent text-accent-foreground': initialNull }" @click="selectValue(null)">
          {{ t("grid.nullValue") }}
        </button>
        <button
          v-for="val in values"
          :key="val"
          type="button"
          class="flex min-h-7 w-full items-center rounded-sm px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
          :class="{ 'bg-accent text-accent-foreground': modelValue === val && !(initialNull && val === '') }"
          @click="selectValue(val)"
        >
          <template v-if="val === ''">
            <code>''</code>
            <span class="ml-2 text-muted-foreground">{{ t("grid.emptyStringValue") }}</span>
          </template>
          <template v-else>{{ val }}</template>
        </button>
      </div>
    </PopoverContent>
  </Popover>
</template>
