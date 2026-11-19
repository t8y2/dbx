<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { NativeJobValue } from "@/lib/database/nativeJobs";

const props = defineProps<{ disabled?: boolean; readonly?: boolean; anydata?: boolean; label: string }>();
const model = defineModel<NativeJobValue>({ required: true });
const { t } = useI18n();
const types = ["varchar2", "char", "nvarchar2", "nchar", "number", "date", "timestamp", "timestamp-tz", "timestamp-ltz", "interval-ym", "interval-ds", "raw", "binary-float", "binary-double", "urowid"];
const typeLabels: Record<string, string> = { "timestamp-tz": "TIMESTAMP WITH TIME ZONE", "timestamp-ltz": "TIMESTAMP WITH LOCAL TIME ZONE", "interval-ym": "INTERVAL YEAR TO MONTH", "interval-ds": "INTERVAL DAY TO SECOND", "binary-float": "BINARY_FLOAT", "binary-double": "BINARY_DOUBLE" };
const envelope = computed(() => {
  const value = model.value;
  return value && typeof value === "object" && !Array.isArray(value) && value.$dbx === "oracle-anydata-v1" ? value : undefined;
});
const type = computed(() => (envelope.value?.typeName === "SYS.NUMBER" ? "number" : typeof envelope.value?.scalarType === "string" ? envelope.value.scalarType : "text"));
const payload = computed(() => (envelope.value ? envelope.value.value : model.value));
const temporal = computed(() => ["date", "timestamp", "timestamp-tz", "timestamp-ltz"].includes(type.value));
const fields = computed(() => (payload.value && typeof payload.value === "object" && !Array.isArray(payload.value) ? payload.value : {}));
const clock = computed(() => {
  const seconds = fields.value.seconds;
  if (typeof seconds !== "string") return "";
  const match = /^(\d{1,5})(\.\d{1,9})?$/.exec(seconds);
  if (!match || BigInt(match[1]!) >= 86400n) return seconds;
  const whole = BigInt(match[1]!);
  return [whole / 3600n, (whole % 3600n) / 60n, whole % 60n].map((part) => part.toString().padStart(2, "0")).join(":") + (match[2] ?? "");
});
const locked = computed(() => props.disabled || props.readonly);
function setPayload(value: NativeJobValue) {
  if (locked.value) return;
  model.value = type.value === "text" ? value : { $dbx: "oracle-anydata-v1", scalarType: type.value, value };
}
function selectType(event: Event) {
  if (locked.value) return;
  const kind = (event.target as HTMLSelectElement).value;
  const value: NativeJobValue = ["date", "timestamp", "timestamp-tz", "timestamp-ltz"].includes(kind) ? { civilDate: "", seconds: "0", ...(kind === "timestamp-tz" ? { region: "+00:00", offset: "+00:00", abbreviation: null } : {}) } : "";
  model.value = kind === "text" ? "" : { $dbx: "oracle-anydata-v1", scalarType: kind, value };
}
function updateField(name: string, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  const next = { ...fields.value, [name]: name === "abbreviation" && value === "" ? null : value };
  if (name === "civilDate") delete next.day;
  setPayload(next);
}
function updateClock(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  const match = /^(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?$/.exec(value);
  const seconds = match && BigInt(match[1]!) < 24n && BigInt(match[2]!) < 60n && BigInt(match[3]!) < 60n ? (BigInt(match[1]!) * 3600n + BigInt(match[2]!) * 60n + BigInt(match[3]!)).toString() + (match[4] ?? "") : value;
  setPayload({ ...fields.value, seconds });
}
function setNull(event: Event) {
  if ((event.target as HTMLInputElement).checked) setPayload(null);
  else setPayload(temporal.value ? { civilDate: "", seconds: "0", ...(type.value === "timestamp-tz" ? { region: "+00:00", offset: "+00:00", abbreviation: null } : {}) } : "");
}
const valueLabel = computed(() => {
  const key = ({ "interval-ym": "scalarMonths", "interval-ds": "scalarNanoseconds", raw: "scalarHex", "binary-float": "scalarFloatHex", "binary-double": "scalarDoubleHex", urowid: "scalarUrowid" } as Record<string, string>)[type.value];
  return key ? t(`nativeJobs.${key}`) : props.label;
});
</script>

<template>
  <div class="grid gap-3">
    <label v-if="anydata || envelope" class="grid gap-1.5">
      <span>{{ t("nativeJobs.scalarStorage") }}</span>
      <select :value="type" class="h-9 rounded border bg-background px-2" :disabled="locked" @change="selectType">
        <option value="text">{{ t("nativeJobs.scalarText") }}</option>
        <option v-for="kind in types" :key="kind" :value="kind">ANYDATA · {{ typeLabels[kind] ?? kind.toUpperCase() }}</option>
      </select>
    </label>
    <label v-if="envelope" class="flex items-center gap-2">
      <input type="checkbox" :checked="payload === null" :disabled="locked" @change="setNull" />
      <span>{{ t("nativeJobs.scalarNull") }}</span>
    </label>
    <template v-if="payload !== null">
      <template v-if="temporal">
        <p v-if="type === 'timestamp-ltz'" class="text-muted-foreground">{{ t("nativeJobs.scalarUtc") }}</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="grid gap-1.5">
            <span>{{ t("nativeJobs.scalarCivilDate") }}</span>
            <input :value="fields.civilDate ?? ''" type="text" placeholder="2026-10-21" class="h-9 rounded border bg-background px-2 font-mono" :disabled="disabled" :readonly="readonly" @input="updateField('civilDate', $event)" />
            <span class="text-muted-foreground">{{ t("nativeJobs.scalarCivilHint") }}</span>
          </label>
          <label class="grid gap-1.5">
            <span>{{ t(type === "date" ? "nativeJobs.scalarDateClock" : "nativeJobs.scalarClock") }}</span>
            <input :value="clock" type="text" :placeholder="type === 'date' ? '12:34:56' : '12:34:56.123456789'" class="h-9 rounded border bg-background px-2 font-mono" :disabled="disabled" :readonly="readonly" @input="updateClock" />
          </label>
          <template v-if="type === 'timestamp-tz'">
            <label
              v-for="field in [
                { name: 'region', key: 'scalarRegion' },
                { name: 'offset', key: 'scalarOffset' },
                { name: 'abbreviation', key: 'scalarAbbreviation' },
              ]"
              :key="field.name"
              class="grid gap-1.5"
            >
              <span>{{ t(`nativeJobs.${field.key}`) }}</span>
              <input :value="fields[field.name] ?? ''" type="text" class="h-9 rounded border bg-background px-2 font-mono" :disabled="disabled" :readonly="readonly" @input="updateField(field.name, $event)" />
            </label>
          </template>
        </div>
      </template>
      <label v-else class="grid gap-1.5">
        <span>{{ valueLabel }}</span>
        <textarea :value="typeof payload === 'string' ? payload : JSON.stringify(payload)" :aria-label="label" class="min-h-20 rounded border bg-background p-2 font-mono text-sm" :disabled="disabled" :readonly="readonly" @input="setPayload(($event.target as HTMLTextAreaElement).value)" />
      </label>
    </template>
  </div>
</template>
