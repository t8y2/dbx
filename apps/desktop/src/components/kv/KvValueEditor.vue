<script setup lang="ts">
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { json } from "@codemirror/lang-json";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { xml } from "@codemirror/lang-xml";
import { StreamLanguage } from "@codemirror/language";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { KvValueFormat } from "@/lib/kv/kvValueFormat";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    format?: KvValueFormat;
    readOnly?: boolean;
  }>(),
  {
    format: "text",
    readOnly: false,
  },
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const host = ref<HTMLElement>();
const languageCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
let view: EditorView | null = null;

function languageExtension(format: KvValueFormat) {
  if (format === "json") return json();
  if (format === "yaml" || format === "kubernetes") return yaml();
  if (format === "xml") return xml();
  if (format === "sql") return sql();
  if (format === "properties") return StreamLanguage.define(properties);
  if (format === "shell") return StreamLanguage.define(shell);
  if (format === "dockerfile") return StreamLanguage.define(dockerFile);
  if (format === "nginx") return StreamLanguage.define(nginx);
  return [];
}

function readOnlyExtensions(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        languageCompartment.of(languageExtension(props.format)),
        readOnlyCompartment.of(readOnlyExtensions(props.readOnly)),
        EditorView.lineWrapping,
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent" },
          ".cm-scroller": { fontFamily: "var(--dbx-editor-font-family, ui-monospace)", overflow: "auto" },
          ".cm-content": { minHeight: "13rem" },
          "&.cm-focused": { outline: "none" },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit("update:modelValue", update.state.doc.toString());
        }),
      ],
    }),
  });
});

watch(
  () => props.modelValue,
  (value) => {
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  },
);

watch(
  () => props.format,
  (format) => view?.dispatch({ effects: languageCompartment.reconfigure(languageExtension(format)) }),
);

watch(
  () => props.readOnly,
  (readOnly) => view?.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyExtensions(readOnly)) }),
);

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>

<template>
  <div ref="host" class="min-h-52 overflow-hidden rounded-md border border-input bg-background" />
</template>
