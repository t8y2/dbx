export type DockerProtocol = "http" | "https" | "unix" | "unix-over-nc" | "unix-over-nc-sudo";

export interface DockerAdminConfig {
  protocol: DockerProtocol;
  socketPath?: string;
  apiVersion?: "auto" | string;
  allowInsecureRemoteHttp?: boolean;
}

export interface DockerConnectionInfo {
  engineVersion: string;
  apiVersion: string;
  minimumApiVersion?: string | null;
  operatingSystem?: string | null;
  architecture?: string | null;
}

export interface DockerEngineSummary {
  engineVersion?: string | null;
  apiVersion?: string | null;
  minimumApiVersion?: string | null;
  operatingSystem?: string | null;
  architecture?: string | null;
  kernelVersion?: string | null;
  storageDriver?: string | null;
  containers?: number | null;
  containersRunning?: number | null;
  containersPaused?: number | null;
  containersStopped?: number | null;
  images?: number | null;
  dockerRootDir?: string | null;
  securityOptions: string[];
  warnings: string[];
}

export interface DockerEngineDetails {
  version: Record<string, unknown>;
  info: Record<string, unknown>;
  summary: DockerEngineSummary;
}

export interface DockerPort {
  ip?: string | null;
  privatePort: number;
  publicPort?: number | null;
  portType: string;
}

export interface DockerContainer {
  id: string;
  names: string[];
  image: string;
  imageId: string;
  command: string;
  created: number;
  state: string;
  status: string;
  ports: DockerPort[];
  labels: Record<string, string>;
  networkIps: Record<string, string>;
}

export interface DockerImage {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  created: number;
  size: number;
  labels: Record<string, string>;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  labels: Record<string, string>;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  attachable: boolean;
  labels: Record<string, string>;
}

export type DockerContainerAction = "start" | "pause" | "unpause" | "stop" | "restart";

export interface DockerContainerStats {
  containerId: string;
  readAt: string;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
  blockRead: number;
  blockWrite: number;
}

export interface DockerPortBinding {
  containerPort: number;
  protocol: "tcp" | "udp";
  hostIp: string;
  hostPort?: number;
}

export interface DockerMountInput {
  type: "bind" | "volume";
  source: string;
  target: string;
  readOnly: boolean;
}

export interface DockerCreateContainerRequest {
  name: string;
  image: string;
  command: string[];
  environment: string[];
  ports: DockerPortBinding[];
  mounts: DockerMountInput[];
  labels: Record<string, string>;
  network?: string;
  restartPolicy: "no" | "always" | "unless-stopped" | "on-failure";
  start: boolean;
}

export interface DockerComposeApplyRequest {
  projectName: string;
  content: string;
  replaceExisting: boolean;
}

export interface DockerComposeApplyResult {
  containerIds: string[];
  warnings: string[];
}

export interface DockerCreateContainerResult {
  id: string;
  warnings: string[];
}

export interface DockerRegistryAuth {
  serverAddress: string;
  username: string;
  password: string;
}

export interface DockerCreateVolumeRequest {
  name: string;
  driver: string;
  labels: Record<string, string>;
  driverOptions: Record<string, string>;
}

export interface DockerCreateNetworkRequest {
  name: string;
  driver: string;
  internal: boolean;
  attachable: boolean;
  subnet?: string;
  gateway?: string;
}

export interface DockerCreateNetworkResult {
  id: string;
  warning: string;
}

export interface DockerLogOptions {
  tail: number;
  timestamps: boolean;
}

export interface DockerFileEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink";
  size: number;
  modified: number;
}

export interface DockerFilePreview {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface DockerStreamEvent {
  sessionId: string;
  chunk: string;
  done: boolean;
  error?: string | null;
}

export interface DockerStreamHandle {
  sessionId: string;
  stop: () => Promise<void>;
}

export interface DockerStreamStartOptions {
  sessionId?: string;
  signal?: AbortSignal;
}

export interface DockerTransferProgress {
  sessionId: string;
  kind: "pull" | "push" | "export";
  direction: "download" | "upload";
  image: string;
  status: "running" | "done" | "error" | "cancelled";
  bytesCompleted: number;
  bytesTotal?: number | null;
  layersCompleted?: number | null;
  layersTotal?: number | null;
  message?: string | null;
  error?: string | null;
}
