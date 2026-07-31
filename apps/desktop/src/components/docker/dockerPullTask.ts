import type { DockerStreamHandle, DockerStreamStartOptions, DockerTransferProgress } from "@/types/docker";

export interface PendingDockerPullTask {
  handle: DockerStreamHandle;
  options: DockerStreamStartOptions;
  progress: DockerTransferProgress;
}

function pullSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `docker-pull-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createPendingDockerPullTask(image: string): PendingDockerPullTask {
  const sessionId = pullSessionId();
  const controller = new AbortController();
  return {
    handle: {
      sessionId,
      stop: async () => controller.abort(),
    },
    options: { sessionId, signal: controller.signal },
    progress: {
      sessionId,
      kind: "pull",
      direction: "download",
      image,
      status: "running",
      bytesCompleted: 0,
      layersCompleted: 0,
      layersTotal: 0,
    },
  };
}
