export interface WindowsWebView2RuntimeFallbackInput {
  installerExitCode: number;
  runtimeDetected: boolean;
  runtimeMeetsMinimum: boolean;
}

export function shouldAbortWindowsWebView2RuntimeFallback(input: WindowsWebView2RuntimeFallbackInput): boolean {
  return input.installerExitCode !== 0 && (!input.runtimeDetected || !input.runtimeMeetsMinimum);
}
