import { mysql, postgresql, sqlite } from "sql-formatter";
import { mapQueryEditorFormatSelection } from "@/lib/editor/queryEditorFormatSelection";
import { formatDataGripSql, type DataGripDialect } from "@/lib/sql/datagrip";
import type { SqlFormatterSettings } from "@/lib/sql/sqlFormatterConfig";

const dialectOptions = { postgres: postgresql, mysql, sqlite };

self.onmessage = async (event: MessageEvent) => {
  const request = event.data;
  try {
    if (request.kind === "mapSelection") {
      const selection = mapQueryEditorFormatSelection(request.sql, request.formatted, request.selection, request.dialect);
      self.postMessage({ requestId: request.requestId, selection });
      return;
    }
    const result = await formatDataGripSql({
      sql: request.sql,
      dialect: request.dialect as DataGripDialect,
      dialectOptions: dialectOptions[request.dialect as DataGripDialect],
      settings: request.settings as SqlFormatterSettings,
      paramTypes: (request.settings as SqlFormatterSettings).paramTypes,
    });
    self.postMessage({ requestId: request.requestId, formatted: result.formatted, metrics: result.metrics });
  } catch (error) {
    const candidate = error as { message?: unknown; offset?: unknown; token?: unknown };
    const message = typeof candidate?.message === "string" ? candidate.message : String(error);
    self.postMessage({
      requestId: request.requestId,
      error: {
        message,
        parseError: (typeof candidate?.offset === "number" && candidate.token !== undefined) || /^Parse error:/i.test(message) || /^Parse error at/i.test(message),
      },
    });
  }
};
