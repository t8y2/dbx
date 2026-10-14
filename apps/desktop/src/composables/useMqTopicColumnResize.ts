import { computed, onBeforeUnmount, ref, watch, type MaybeRefOrGetter, toValue } from "vue";
import type { MqSystemKind } from "@/types/mq";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export interface MqTopicColumn {
  key: string;
  label: string;
  minWidth: number;
  track: string;
}

/** Widths are keyed by column identity so the optional vhost column cannot shift them. */
export function useMqTopicColumnResize(systemKind: MaybeRefOrGetter<MqSystemKind | undefined>, showNamespace: MaybeRefOrGetter<boolean>) {
  const storageKey = computed(() => `dbx-mq-topic-column-widths:${toValue(systemKind) ?? "pulsar"}`);
  const columns = computed<MqTopicColumn[]>(() => {
    const kind = toValue(systemKind);
    const rabbit = kind === "rabbitmq";
    const rocket = kind === "rocketmq";
    const result: MqTopicColumn[] = [{ key: "name", label: "mqTopics.name", minWidth: 180, track: "minmax(180px, 1.6fr)" }];
    if (toValue(showNamespace)) result.push({ key: "namespace", label: "mqAdmin.namespace", minWidth: 100, track: "minmax(100px, 0.8fr)" });
    result.push({ key: "type", label: rabbit ? "mqTopics.rabbitmqQueueType" : "mqTopics.type", minWidth: 80, track: rabbit ? "110px" : "120px" });
    if (rabbit) {
      result.push(
        { key: "features", label: "mqTopics.rabbitmqFeatures", minWidth: 80, track: "170px" },
        { key: "messages", label: "mqTopics.messageCount", minWidth: 70, track: "90px" },
        { key: "consumers", label: "mqTopics.consumers", minWidth: 70, track: "70px" },
        { key: "rates", label: "mqTopics.rabbitmqRates", minWidth: 100, track: "190px" },
      );
    } else if (!rocket) {
      result.push({ key: "partitions", label: "mqTopics.partitions", minWidth: 80, track: "140px" });
    }
    result.push({ key: "actions", label: "mqTopics.actions", minWidth: rocket ? 560 : 150, track: rocket ? "minmax(560px, 2.2fr)" : "minmax(150px, 1fr)" });
    return result;
  });
  const widths = ref<Record<string, number>>({});
  const resizingColumn = ref<string | null>(null);
  let stopResize: (() => void) | undefined;

  watch(
    storageKey,
    (key) => {
      stopResize?.();
      widths.value = {};
      try {
        const parsed: unknown = JSON.parse(safeLocalStorageGet(key) ?? "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        for (const [column, width] of Object.entries(parsed)) {
          if (typeof width === "number" && Number.isFinite(width) && width > 0) widths.value[column] = width;
        }
      } catch {
        // Corrupt or unavailable storage must not prevent the topic list from opening.
      }
    },
    { immediate: true },
  );

  function savedWidth(column: MqTopicColumn): number | undefined {
    const width = widths.value[column.key];
    return width === undefined ? undefined : Math.max(column.minWidth, width);
  }

  const gridTemplateColumns = computed(() =>
    columns.value
      .map((column) => {
        const width = savedWidth(column);
        return width === undefined ? column.track : `${width}px`;
      })
      .join(" "),
  );
  const minWidth = computed(() => columns.value.reduce((sum, column) => sum + (savedWidth(column) ?? (Number.parseFloat(column.track) || column.minWidth)), 24 + (columns.value.length - 1) * 8));

  function onResizeStart(column: MqTopicColumn, event: MouseEvent) {
    if (event.button !== 0) return;
    const cell = (event.currentTarget as HTMLElement).parentElement;
    if (!cell) return;
    stopResize?.();
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = cell.getBoundingClientRect().width;
    const key = storageKey.value;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    resizingColumn.value = column.key;

    const onMove = (moveEvent: MouseEvent) => {
      widths.value = { ...widths.value, [column.key]: Math.max(column.minWidth, Math.round(startWidth + moveEvent.clientX - startX)) };
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", cleanup);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      resizingColumn.value = null;
      stopResize = undefined;
    };
    const onUp = (upEvent: MouseEvent) => {
      onMove(upEvent);
      safeLocalStorageSet(key, JSON.stringify(widths.value));
      cleanup();
    };
    stopResize = cleanup;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    window.addEventListener("blur", cleanup);
  }

  watch(
    () => toValue(showNamespace),
    () => stopResize?.(),
  );
  onBeforeUnmount(() => stopResize?.());
  return { columns, gridTemplateColumns, minWidth, resizingColumn, onResizeStart };
}
