import type { DockerTransferProgress } from "@/types/docker";

export interface DockerProgressParseState {
  pending: string;
  layers: Map<string, boolean>;
}

export interface DockerProgressParseInput {
  sessionId: string;
  kind: "pull" | "push";
  image: string;
  chunk: string;
  done: boolean;
  error?: string | null;
  cancelled?: boolean;
  current?: DockerTransferProgress;
}

export function createDockerProgressParseState(): DockerProgressParseState {
  return { pending: "", layers: new Map() };
}

export function parseDockerProgressEvent(state: DockerProgressParseState, input: DockerProgressParseInput): DockerTransferProgress {
  const buffered = `${state.pending}${input.chunk}`.replace(/\r\n/g, "\n");
  const lines = buffered.split("\n");
  const remainder = lines.pop() ?? "";
  state.pending = input.done ? "" : remainder;
  if (input.done && remainder) lines.push(remainder);

  let bytesCompleted = input.current?.bytesCompleted ?? 0;
  let bytesTotal = input.current?.bytesTotal;
  let layersCompleted = input.current?.layersCompleted ?? 0;
  let layersTotal = input.current?.layersTotal ?? 0;
  let streamError = input.error || input.current?.error;

  for (const line of lines.filter(Boolean)) {
    try {
      const value = JSON.parse(line);
      streamError ||= value.error || value.errorDetail?.message;
      const id = String(value.id || "");
      if (id) state.layers.set(id, /complete|already exists|pushed|mounted/i.test(String(value.status || "")));
      const detail = value.progressDetail;
      if (detail?.current != null) bytesCompleted = Math.max(bytesCompleted, Number(detail.current) || 0);
      if (detail?.total != null) bytesTotal = Math.max(bytesTotal || 0, Number(detail.total) || 0);
    } catch {
      bytesCompleted += new TextEncoder().encode(line).byteLength;
    }
  }

  if (state.layers.size) {
    layersTotal = Math.max(layersTotal, state.layers.size);
    layersCompleted = Math.max(layersCompleted, [...state.layers.values()].filter(Boolean).length);
  }

  return {
    sessionId: input.sessionId,
    kind: input.kind,
    direction: input.kind === "push" ? "upload" : "download",
    image: input.image,
    status: input.cancelled ? "cancelled" : streamError ? "error" : input.done ? "done" : "running",
    bytesCompleted,
    bytesTotal,
    layersCompleted,
    layersTotal,
    message: input.chunk,
    error: streamError,
  };
}
