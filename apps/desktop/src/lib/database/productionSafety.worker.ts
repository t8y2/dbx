import { assessProductionSql } from "./productionSafety";
import type { ProductionSafetyRequest } from "./productionSafetyWorker";

self.onmessage = (event: MessageEvent<{ id: number; input: ProductionSafetyRequest }>) => {
  const { id, input } = event.data;
  try {
    self.postMessage({ id, result: assessProductionSql(input.sql, input.connection, input.database) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
