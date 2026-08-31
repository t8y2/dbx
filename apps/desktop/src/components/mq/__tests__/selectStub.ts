import { defineComponent, h, inject, provide } from "vue";

export function createSelectStub() {
  const updateKey = Symbol("select-update");
  const Select = defineComponent({
    emits: ["update:modelValue"],
    setup(_, { emit, slots }) {
      provide(updateKey, (value: string) => emit("update:modelValue", value));
      return () => h("div", { "data-slot": "select" }, slots.default?.());
    },
  });
  const SelectTrigger = defineComponent({
    setup(_, { attrs, slots }) {
      return () => h("button", { ...attrs, type: "button" }, slots.default?.());
    },
  });
  const SelectContent = defineComponent({
    setup(_, { attrs, slots }) {
      return () => h("div", attrs, slots.default?.());
    },
  });
  const SelectItem = defineComponent({
    props: { value: { type: String, required: true } },
    setup(props, { attrs, slots }) {
      const update = inject<(value: string) => void>(updateKey);
      return () => h("button", { ...attrs, "data-slot": "select-item", "data-value": props.value, type: "button", onClick: () => update?.(props.value) }, slots.default?.());
    },
  });
  const SelectValue = defineComponent({
    setup(_, { attrs, slots }) {
      return () => h("span", attrs, slots.default?.());
    },
  });

  return { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
}
