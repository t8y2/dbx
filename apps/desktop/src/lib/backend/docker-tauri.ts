import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DockerConnectionInfo,
  DockerEngineDetails,
  DockerContainer,
  DockerContainerAction,
  DockerContainerStats,
  DockerCreateContainerRequest,
  DockerCreateContainerResult,
  DockerComposeApplyRequest,
  DockerComposeApplyResult,
  DockerCreateNetworkRequest,
  DockerCreateNetworkResult,
  DockerCreateVolumeRequest,
  DockerFileEntry,
  DockerFilePreview,
  DockerImage,
  DockerLogOptions,
  DockerNetwork,
  DockerRegistryAuth,
  DockerStreamEvent,
  DockerStreamHandle,
  DockerStreamStartOptions,
  DockerTransferProgress,
  DockerVolume,
} from "@/types/docker";

export function dockerTestConnection(connectionId: string): Promise<DockerConnectionInfo> {
  return invoke("docker_test_connection", { connectionId });
}

export function dockerGetEngineDetails(connectionId: string): Promise<DockerEngineDetails> {
  return invoke("docker_get_engine_details", { connectionId });
}

export function dockerListContainers(connectionId: string, all = true): Promise<DockerContainer[]> {
  return invoke("docker_list_containers", { connectionId, all });
}

export function dockerListImages(connectionId: string): Promise<DockerImage[]> {
  return invoke("docker_list_images", { connectionId });
}

export function dockerListVolumes(connectionId: string): Promise<DockerVolume[]> {
  return invoke("docker_list_volumes", { connectionId });
}

export function dockerListNetworks(connectionId: string): Promise<DockerNetwork[]> {
  return invoke("docker_list_networks", { connectionId });
}

export function dockerContainerAction(connectionId: string, containerId: string, action: DockerContainerAction): Promise<void> {
  return invoke("docker_container_action", { connectionId, containerId, action });
}

export function dockerInspectContainer(connectionId: string, containerId: string): Promise<unknown> {
  return invoke("docker_inspect_container", { connectionId, containerId });
}

export function dockerContainerStats(connectionId: string, containerIds: string[]): Promise<DockerContainerStats[]> {
  return invoke("docker_container_stats", { connectionId, containerIds });
}

export function dockerCreateContainer(connectionId: string, request: DockerCreateContainerRequest): Promise<DockerCreateContainerResult> {
  return invoke("docker_create_container", { connectionId, request });
}

export function dockerApplyCompose(connectionId: string, request: DockerComposeApplyRequest): Promise<DockerComposeApplyResult> {
  return invoke("docker_apply_compose", { connectionId, request });
}

export function dockerRemoveContainer(connectionId: string, containerId: string): Promise<void> {
  return invoke("docker_remove_container", { connectionId, containerId });
}

export function dockerRemoveImage(connectionId: string, imageId: string): Promise<void> {
  return invoke("docker_remove_image", { connectionId, imageId });
}

export function dockerCreateVolume(connectionId: string, request: DockerCreateVolumeRequest): Promise<DockerVolume> {
  return invoke("docker_create_volume", { connectionId, request });
}

export function dockerCreateNetwork(connectionId: string, request: DockerCreateNetworkRequest): Promise<DockerCreateNetworkResult> {
  return invoke("docker_create_network", { connectionId, request });
}

export function dockerListContainerFiles(connectionId: string, containerId: string, path: string): Promise<DockerFileEntry[]> {
  return invoke("docker_list_container_files", { connectionId, containerId, path });
}

export function dockerPreviewContainerFile(connectionId: string, containerId: string, path: string): Promise<DockerFilePreview> {
  return invoke("docker_preview_container_file", { connectionId, containerId, path });
}

export function dockerExportImageToPath(connectionId: string, imageId: string, destinationPath: string): Promise<number> {
  return invoke("docker_export_image_to_path", { connectionId, imageId, destinationPath });
}

function streamSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `docker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function startTauriStream(eventName: "docker-log-stream" | "docker-image-pull", command: "docker_start_logs" | "docker_pull_image", payload: Record<string, unknown>, onEvent: (event: DockerStreamEvent) => void, options: DockerStreamStartOptions = {}): Promise<DockerStreamHandle> {
  const sessionId = options.sessionId || streamSessionId();
  let cancelled = false;
  let completed = false;
  let backendStarted = false;
  let backendStopSent = false;
  let unlisten: (() => void) | undefined;
  const cleanup = () => {
    unlisten?.();
    unlisten = undefined;
    options.signal?.removeEventListener("abort", abortFromCaller);
  };
  const stopBackend = async () => {
    if (!backendStarted || backendStopSent) return;
    backendStopSent = true;
    await invoke("docker_stop_stream", { sessionId });
  };
  const handle: DockerStreamHandle = {
    sessionId,
    stop: async () => {
      if (completed || cancelled) return;
      cancelled = true;
      cleanup();
      await stopBackend();
    },
  };
  const abortFromCaller = () => void handle.stop().catch(() => undefined);
  if (options.signal?.aborted) {
    cancelled = true;
    return handle;
  }
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  unlisten = await listen<DockerStreamEvent>(eventName, (event) => {
    if (event.payload.sessionId !== sessionId) return;
    onEvent(event.payload);
    if (event.payload.done) {
      completed = true;
      cleanup();
    }
  });
  if (cancelled) {
    cleanup();
    return handle;
  }
  try {
    await invoke(command, { ...payload, sessionId });
    backendStarted = true;
    if (cancelled) await stopBackend();
  } catch (error) {
    cleanup();
    throw error;
  }
  return handle;
}

export function dockerStartLogs(connectionId: string, containerId: string, options: DockerLogOptions, onEvent: (event: DockerStreamEvent) => void): Promise<DockerStreamHandle> {
  return startTauriStream("docker-log-stream", "docker_start_logs", { connectionId, containerId, options }, onEvent);
}

export function dockerPullImage(connectionId: string, image: string, auth: DockerRegistryAuth | undefined, onEvent: (event: DockerStreamEvent) => void, options?: DockerStreamStartOptions): Promise<DockerStreamHandle> {
  return startTauriStream("docker-image-pull", "docker_pull_image", { connectionId, image, auth }, onEvent, options);
}

export async function dockerPushImage(connectionId: string, sourceImageId: string, targetReference: string, auth: DockerRegistryAuth | undefined, onEvent: (event: DockerTransferProgress) => void): Promise<DockerStreamHandle> {
  const sessionId = streamSessionId();
  let stopped = false;
  const unlisten = await listen<DockerTransferProgress>("docker-transfer-progress", (event) => {
    if (event.payload.sessionId !== sessionId) return;
    onEvent(event.payload);
    if (event.payload.status !== "running") {
      stopped = true;
      unlisten();
    }
  });
  try {
    await invoke("docker_push_image", { connectionId, sourceImageId, targetReference, auth, sessionId });
  } catch (error) {
    unlisten();
    throw error;
  }
  return {
    sessionId,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      unlisten();
      await invoke("docker_stop_transfer", { sessionId });
    },
  };
}

export async function dockerStartImageExport(connectionId: string, imageId: string, fileName: string, destinationPath: string | undefined, onEvent: (event: DockerTransferProgress) => void): Promise<DockerStreamHandle> {
  if (!destinationPath) throw new Error(`A destination is required for ${fileName}`);
  const sessionId = streamSessionId();
  let stopped = false;
  const unlisten = await listen<DockerTransferProgress>("docker-transfer-progress", (event) => {
    if (event.payload.sessionId !== sessionId) return;
    onEvent(event.payload);
    if (event.payload.status !== "running") {
      stopped = true;
      unlisten();
    }
  });
  try {
    await invoke("docker_start_image_export", { connectionId, imageId, displayName: fileName, destinationPath, sessionId });
  } catch (error) {
    unlisten();
    throw error;
  }
  return {
    sessionId,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      unlisten();
      await invoke("docker_stop_transfer", { sessionId });
    },
  };
}
