import { Channel, invoke } from "@tauri-apps/api/core";
import type { SshProfile, SshTerminalDriverManifest, SshTerminalEvent, SshTerminalSize } from "@/types/ssh";

export function listSshProfiles(): Promise<SshProfile[]> {
  return invoke("list_ssh_profiles");
}

export function saveSshProfile(profile: SshProfile): Promise<SshProfile> {
  return invoke("save_ssh_profile", { profile });
}

export function deleteSshProfile(profileId: string): Promise<boolean> {
  return invoke("delete_ssh_profile", { profileId });
}

export function listSshTerminalDrivers(): Promise<SshTerminalDriverManifest[]> {
  return invoke("list_ssh_terminal_drivers");
}

export function testSshTerminalProfile(profile: SshProfile): Promise<void> {
  return invoke("test_ssh_terminal_profile", { profile });
}

export async function openSshTerminal(profileId: string, size: SshTerminalSize, onEvent: (event: SshTerminalEvent) => void): Promise<string> {
  const channel = new Channel<SshTerminalEvent>();
  channel.onmessage = onEvent;
  return invoke("open_ssh_terminal", { profileId, size, onEvent: channel });
}

export function writeSshTerminal(sessionId: string, data: string): Promise<void> {
  return invoke("write_ssh_terminal", { sessionId, data });
}

export function resizeSshTerminal(sessionId: string, size: SshTerminalSize): Promise<void> {
  return invoke("resize_ssh_terminal", { sessionId, size });
}

export function closeSshTerminal(sessionId: string): Promise<boolean> {
  return invoke("close_ssh_terminal", { sessionId });
}
