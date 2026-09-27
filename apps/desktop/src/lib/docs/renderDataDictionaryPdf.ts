import type { DataDictionaryLabels, DictionaryLayout, DictionaryTable } from "./dataDictionary";

export function renderDataDictionaryPdf(tables: DictionaryTable[], labels: DataDictionaryLabels, layout: DictionaryLayout, warnings: string[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./dataDictionaryPdf.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ bytes?: Uint8Array; error?: string }>) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.bytes) resolve(event.data.bytes);
      else reject(new Error("PDF worker returned no data"));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage({ tables, labels, layout, warnings });
  });
}
