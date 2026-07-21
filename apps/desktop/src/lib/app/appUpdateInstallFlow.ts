import { shouldBlockAppUpdate } from "@/lib/app/appUpdateTaskGuard";

export type UpdateDownloadFlowResult = "blocked" | "downloaded" | "installed";

interface UpdateDownloadFlowOptions {
  getActiveTaskCount: () => number;
  download: () => Promise<void>;
  install: () => Promise<void>;
}

interface DownloadedUpdateInstallOptions {
  getActiveTaskCount: () => number;
  install: () => Promise<void>;
}

export async function downloadAndInstallUpdateWhenIdle(options: UpdateDownloadFlowOptions): Promise<UpdateDownloadFlowResult> {
  if (shouldBlockAppUpdate(options.getActiveTaskCount())) return "blocked";

  await options.download();
  if (shouldBlockAppUpdate(options.getActiveTaskCount())) return "downloaded";

  await options.install();
  return "installed";
}

export async function installDownloadedUpdateWhenIdle(options: DownloadedUpdateInstallOptions): Promise<boolean> {
  if (shouldBlockAppUpdate(options.getActiveTaskCount())) return false;

  await options.install();
  return true;
}
