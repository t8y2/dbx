export const REDIS_MONITOR_MAX_ROWS = 1000;

export function isRedisMonitorCommand(command: string): boolean {
  return /^MONITOR\s*;?$/i.test(command.trim());
}

export function startRedisMonitor(connect: () => Promise<WebSocket>, onRows: (rows: string[]) => void) {
  let socket: WebSocket | undefined;
  let finished = false;
  let rows: string[] = [];
  let dirty = false;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const flush = () => {
    if (dirty) {
      dirty = false;
      onRows(rows.slice());
    }
  };
  const timer = setInterval(flush, 100);
  const timeout = setTimeout(() => finish(new Error("Redis MONITOR connection timed out")), 30000);
  function finish(error?: Error) {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    clearTimeout(timeout);
    flush();
    socket?.close();
    if (error) rejectDone(error);
    else resolveDone();
  }
  void connect()
    .then((connected) => {
      socket = connected;
      if (finished) {
        socket.close();
        return;
      }
      socket.onmessage = (event) => {
        if (finished) return;
        try {
          const data = JSON.parse(event.data);
          if (typeof data.error === "string") {
            finish(new Error(data.error));
          } else if (data.ready === true) {
            clearTimeout(timeout);
            onRows([]);
          } else if (typeof data.message === "string") {
            rows.push(data.message.slice(0, 16384));
            if (rows.length > REDIS_MONITOR_MAX_ROWS) rows = rows.slice(-REDIS_MONITOR_MAX_ROWS);
            dirty = true;
          }
        } catch {
          finish(new Error("Invalid Redis MONITOR response"));
        }
      };
      socket.onerror = () => finish(new Error("Redis MONITOR connection failed"));
      socket.onclose = () => finish(new Error("Redis MONITOR connection closed"));
    })
    .catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  return { done, stop: () => finish() };
}
