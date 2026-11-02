import { defineComponent, h, nextTick } from "vue";

// Keep the scope's v-model contract while avoiding portal/pointer behavior in panel tests.
export const Select = defineComponent({
  props: { modelValue: String },
  emits: ["update:modelValue"],
  setup(props, { emit, slots }) {
    return () =>
      h(
        "select",
        {
          "data-search-mode": "true",
          value: props.modelValue,
          onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value),
        },
        slots.default?.(),
      );
  },
});
export const SelectContent = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      slots.default?.(),
});
export const SelectItem = defineComponent({
  props: { value: String },
  setup:
    (props, { slots }) =>
    () =>
      h("option", { value: props.value }, slots.default?.()),
});
export const SelectTrigger = defineComponent({ setup: () => () => null });
export const SelectValue = SelectTrigger;

export async function changeSearchMode(host: HTMLElement, mode: "name" | "content") {
  const select = host.querySelector<HTMLSelectElement>("[data-search-mode]")!;
  select.value = mode;
  select.dispatchEvent(new Event("change"));
  await nextTick();
}
