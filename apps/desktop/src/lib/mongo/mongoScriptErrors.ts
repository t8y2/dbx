type Translate = (key: string, params?: Record<string, unknown>) => string;

const CONFIRMED = /^Confirmed completed operations: (\d+) \((\d+) writes\)\.$/;
const UNKNOWN = /^Outcome unknown, it may or may not have been applied: (.*)$/;
const NOT_ROLLED_BACK = /^Writes are not rolled back\.$/;
const TIMED_OUT = /^MongoDB script timed out after (\d+) ms\.$/;

/** Whether a failed script reported operations that already ran (writes may have been applied). */
export function mongoScriptErrorReportsProgress(message: string): boolean {
  return message.split("\n").some((line) => CONFIRMED.test(line) || UNKNOWN.test(line));
}

/** Localizes the progress lines the backend appends to a failed MongoDB script's error. */
export function localizeMongoScriptError(message: string, t: Translate): string {
  return message
    .split("\n")
    .map((line) => {
      let match = CONFIRMED.exec(line);
      if (match) return t("mongoScript.progressConfirmed", { count: Number(match[1]), writes: Number(match[2]) });
      match = UNKNOWN.exec(line);
      if (match) return t("mongoScript.progressUnknown", { operation: match[1] });
      if (NOT_ROLLED_BACK.test(line)) return t("mongoScript.progressNotRolledBack");
      match = TIMED_OUT.exec(line);
      if (match) return t("mongoScript.timedOut", { ms: Number(match[1]) });
      return line;
    })
    .join("\n");
}

const CAUGHT_UNKNOWN = /^A failed write was caught by the script; its outcome is unknown: ([\s\S]*)$/;
const CAUGHT_DROPPED = /^(\d+) more failed writes were caught by the script; their outcome is unknown\.$/;

/**
 * Localizes the messages a successful MongoDB script reports (its writes, and failed writes it
 * caught itself), recognised by their backend code.
 */
export function localizeMongoScriptMessages<M extends { code?: string | null; message: string }>(messages: M[] | undefined, t: Translate): M[] | undefined {
  return messages?.map((entry) => {
    let match: RegExpExecArray | null = null;
    if (entry.code === "MONGO_SCRIPT_WRITES" && (match = CONFIRMED.exec(entry.message))) {
      return { ...entry, message: t("mongoScript.progressConfirmed", { count: Number(match[1]), writes: Number(match[2]) }) };
    }
    if (entry.code === "MONGO_SCRIPT_UNKNOWN_WRITE" && (match = CAUGHT_UNKNOWN.exec(entry.message))) {
      return { ...entry, message: t("mongoScript.messageUnknownWrite", { operation: match[1] }) };
    }
    if (entry.code === "MONGO_SCRIPT_UNKNOWN_WRITES_DROPPED" && (match = CAUGHT_DROPPED.exec(entry.message))) {
      return { ...entry, message: t("mongoScript.messageUnknownWritesDropped", { count: Number(match[1]) }) };
    }
    return entry;
  });
}
