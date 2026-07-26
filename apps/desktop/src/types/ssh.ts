export type SshAuthMethod = "password" | "key" | "agent" | "key+password" | "none";

export interface SshProfile {
  id: string;
  name: string;
  driverId: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password: string;
  keyPath: string;
  keyPassphrase: string;
  sshAgentSockPath: string;
  connectTimeoutSecs: number;
  terminalType: string;
}

export interface SshTerminalSize {
  columns: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface SshTerminalDriverManifest {
  id: string;
  name: string;
  version: string;
  builtIn: boolean;
  capabilities: string[];
}

export type SshTerminalEvent = { type: "ready" } | { type: "data"; data: string } | { type: "exit"; exitCode: number | null; signal: string | null } | { type: "error"; message: string };
