import { buildDataDictionaryPdf } from "./dataDictionaryPdf";
import type { DataDictionaryLabels, DictionaryLayout, DictionaryTable } from "./dataDictionary";

self.onmessage = (event: MessageEvent<{ tables: DictionaryTable[]; labels: DataDictionaryLabels; layout: DictionaryLayout; warnings: string[] }>) => {
  try {
    const { tables, labels, layout, warnings } = event.data;
    const bytes = buildDataDictionaryPdf(tables, labels, layout, warnings);
    self.postMessage({ bytes }, { transfer: [bytes.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
