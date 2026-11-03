import { checkMongoScript } from "./mongoScriptCheck";
import type { MongoScriptExpansion } from "./mongoScriptRecorder";
import { describeMongoCommandParseFailure, parseMongoCommand, type ParsedMongoCommandRange } from "./mongoShellCommand";

export { isMongoScriptSyntax } from "./mongoScriptCheck";

export const MONGO_SCRIPT_TIMEOUT_MS = 5000;

/**
 * Records the db calls of a Mongo shell script in a dedicated worker. The
 * worker has no access to the app or its IPC bridge, and is terminated when
 * the script runs longer than the timeout, so an endless loop cannot hang
 * the editor.
 */
export function expandMongoScript(script: string, timeoutMs = MONGO_SCRIPT_TIMEOUT_MS): Promise<MongoScriptExpansion> {
  const problem = checkMongoScript(script);
  if (problem) return Promise.resolve({ ok: false, error: problem });
  if (typeof Worker === "undefined") return Promise.resolve({ ok: false, error: "Mongo scripts need Web Worker support." });

  return new Promise((resolve) => {
    const worker = new Worker(new URL("./mongoScript.worker.ts", import.meta.url), { type: "module" });
    const finish = (result: MongoScriptExpansion) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `The script did not finish within ${timeoutMs / 1000} s.` }), timeoutMs);
    worker.onmessage = (event: MessageEvent<MongoScriptExpansion>) => finish(event.data);
    worker.onerror = (event) => finish({ ok: false, error: `Script error: ${event.message || "the script worker failed"}` });
    worker.postMessage({ script });
  });
}

/** Expands a script into editor commands spanning the whole script, or throws with the reason it cannot run. */
export async function expandMongoScriptCommands(script: string): Promise<ParsedMongoCommandRange[]> {
  const expansion = await expandMongoScript(script);
  if (!expansion.ok) throw new Error(expansion.error);
  return expansion.commands.map((text) => {
    const parsed = parseMongoCommand(text);
    if (parsed) return { from: 0, to: script.length, ...parsed };
    // A lone command the parser rejects is a plain command mistake: diagnose the text as written.
    if (expansion.commands.length === 1) throw new Error(describeMongoCommandParseFailure(script));
    throw new Error(`The script made an unsupported call ${text}: ${describeMongoCommandParseFailure(text)}`);
  });
}
