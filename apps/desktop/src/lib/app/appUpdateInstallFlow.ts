import { shouldBlockAppUpdate } from "@/lib/app/appUpdateTaskGuard";

interface DownloadedUpdateInstallOptions {
  getActiveTaskCount: () => number;
  install: () => Promise<void>;
}

export async function installDownloadedUpdateWhenIdle(options: DownloadedUpdateInstallOptions): Promise<boolean> {
  if (shouldBlockAppUpdate(options.getActiveTaskCount())) return false;

  await options.install();
  return true;
}
