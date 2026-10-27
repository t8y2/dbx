import { onBeforeUnmount, watch } from "vue";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";
import { queryRecords } from "@/lib/database/postgresLocks";

type AdminSession = { connectionId: string; database: string; id: string; active: number; closing: boolean };
/** Queries with this ID share a physical backend in native and JDBC transports. */
export function usePostgresAdminSession(connection: () => ConnectionConfig) {
  const sessions = new Map<string, AdminSession>();
  let disposed = false;
  function close(session: AdminSession) {
    if (!session.closing || session.active) return;
    sessions.delete(session.id);
    void api.closeClientConnectionSession(session.connectionId, session.database, session.id).catch(() => undefined);
  }
  async function query(database: string, sql: string, maxRows = 5000) {
    if (disposed) throw new Error("Administration panel closed");
    const config = connection();
    let session = [...sessions.values()].find((item) => !item.closing && item.connectionId === config.id && item.database === database);
    if (!session) {
      for (const old of sessions.values()) {
        old.closing = true;
        close(old);
      }
      session = { connectionId: config.id, database, id: `pg-admin:${uuid()}`, active: 0, closing: false };
      sessions.set(session.id, session);
    }
    session.active++;
    try {
      const result = await api.executeQuery(session.connectionId, database, sql, undefined, undefined, { clientSessionId: session.id, maxRows, timeoutSecs: 15 });
      queryRecords(result);
      return result;
    } finally {
      session.active--;
      close(session);
    }
  }
  watch(
    () => JSON.stringify(connection()),
    () => {
      for (const session of sessions.values()) {
        session.closing = true;
        close(session);
      }
    },
  );
  onBeforeUnmount(() => {
    disposed = true;
    for (const session of sessions.values()) {
      session.closing = true;
      close(session);
    }
  });
  return { query };
}
