import { readFileSync } from "node:fs";
import { nextTick, ref, watch } from "vue";
import { describe, expect, it } from "vitest";

const objectBrowserSource = readFileSync(new URL("../../../components/objects/ObjectBrowser.vue", import.meta.url), "utf8");

describe("ObjectBrowser context watcher", () => {
  it("watches context fields independently", () => {
    expect(objectBrowserSource).toContain("[() => props.connection.id, () => props.database, () => props.schema]");
    expect(objectBrowserSource).not.toContain("() => [props.connection.id, props.database, props.schema]");
  });

  it("ignores connection object replacement when the context values stay unchanged", async () => {
    const connection = ref({ id: "connection-1" });
    const database = ref("database-1");
    const schema = ref<string | undefined>("public");
    let reloads = 0;
    const stop = watch([() => connection.value.id, () => database.value, () => schema.value], () => reloads++);

    connection.value = { id: "connection-1" };
    await nextTick();
    expect(reloads).toBe(0);

    schema.value = "audit";
    await nextTick();
    expect(reloads).toBe(1);
    stop();
  });
});
