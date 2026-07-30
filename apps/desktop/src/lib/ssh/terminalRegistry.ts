import { reactive } from "vue";

import type { SshProfile } from "@/types/ssh";

export type SshConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface SshTerminalRuntimeContext {
  profile?: SshProfile;
  status: SshConnectionStatus;
  statusDetail: string;
  transcript: string;
}

const contexts = reactive<Record<string, SshTerminalRuntimeContext>>({});

function contextFor(profileId: string): SshTerminalRuntimeContext {
  return (contexts[profileId] ??= {
    status: "disconnected",
    statusDetail: "",
    transcript: "",
  });
}

export function sshTerminalRuntimeContext(profileId: string | undefined): SshTerminalRuntimeContext | undefined {
  return profileId ? contexts[profileId] : undefined;
}

export function setSshTerminalProfile(profile: SshProfile) {
  contextFor(profile.id).profile = profile;
}

export function setSshTerminalStatus(profileId: string, status: SshConnectionStatus, statusDetail = "") {
  const context = contextFor(profileId);
  context.status = status;
  context.statusDetail = statusDetail;
}

export function setSshTerminalTranscript(profileId: string, transcript: string) {
  contextFor(profileId).transcript = transcript;
}
