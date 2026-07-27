import type { NacosDashboardMetrics, NacosDashboardSnapshot } from "@/types/nacos";

export const MAX_NACOS_DASHBOARD_SAMPLES = 60;

export interface NacosDashboardSample {
  at: number;
  snapshot: NacosDashboardSnapshot;
}

export type NacosDashboardMetricKey = keyof NacosDashboardMetrics;

export type NullableMetric = number | null;
export type NacosMetricSelector = (sample: NacosDashboardSample) => number | undefined;

export function dashboardNamespaceLabel(snapshotNamespace: string | undefined, requestedNamespace: string | undefined): string {
  return (snapshotNamespace !== undefined ? snapshotNamespace : requestedNamespace) || "public";
}

export function hasContinuousPrometheusSource(previous: NacosDashboardSample, current: NacosDashboardSample): boolean {
  const previousSource = previous.snapshot.prometheus?.source;
  const currentSource = current.snapshot.prometheus?.source;
  const previousIdentity = previousSource?.fingerprint ?? previousSource?.endpoint;
  const currentIdentity = currentSource?.fingerprint ?? currentSource?.endpoint;
  return !!previousSource && !!currentSource && previousSource.kind === currentSource.kind && previousIdentity === currentIdentity;
}

export function finiteMetric(value: number | undefined): NullableMetric {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function dashboardMetric(sample: NacosDashboardSample | undefined, key: NacosDashboardMetricKey): NullableMetric {
  const value = sample?.snapshot.metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function dashboardSeries(samples: readonly NacosDashboardSample[], key: NacosDashboardMetricKey): NullableMetric[] {
  return samples.map((sample) => dashboardMetric(sample, key));
}

export function gaugeSeries(samples: readonly NacosDashboardSample[], selector: NacosMetricSelector): NullableMetric[] {
  return samples.map((sample) => finiteMetric(selector(sample)));
}

export function counterRateSeries(samples: readonly NacosDashboardSample[], selector: NacosMetricSelector): NullableMetric[] {
  return samples.map((sample, index) => {
    if (index === 0) return null;
    const previousSample = samples[index - 1];
    if (!hasContinuousPrometheusSource(previousSample, sample)) return null;
    const previous = finiteMetric(selector(previousSample));
    const current = finiteMetric(selector(sample));
    const elapsedSeconds = (sample.at - samples[index - 1].at) / 1_000;
    if (previous === null || current === null || current < previous || elapsedSeconds <= 0) return null;
    return (current - previous) / elapsedSeconds;
  });
}

export function averageDurationMsSeries(samples: readonly NacosDashboardSample[], sumSelector: NacosMetricSelector, countSelector: NacosMetricSelector): NullableMetric[] {
  return samples.map((sample, index) => {
    if (index === 0) return null;
    const previousSample = samples[index - 1];
    if (!hasContinuousPrometheusSource(previousSample, sample)) return null;
    const previousSum = finiteMetric(sumSelector(previousSample));
    const currentSum = finiteMetric(sumSelector(sample));
    const previousCount = finiteMetric(countSelector(samples[index - 1]));
    const currentCount = finiteMetric(countSelector(sample));
    if (previousSum === null || currentSum === null || previousCount === null || currentCount === null) return null;
    const sumDelta = currentSum - previousSum;
    const countDelta = currentCount - previousCount;
    if (sumDelta < 0 || countDelta <= 0) return null;
    return (sumDelta / countDelta) * 1_000;
  });
}

export function errorRateSeries(samples: readonly NacosDashboardSample[], errorSelector: NacosMetricSelector, requestSelector: NacosMetricSelector): NullableMetric[] {
  return samples.map((sample, index) => {
    if (index === 0) return null;
    const previousSample = samples[index - 1];
    if (!hasContinuousPrometheusSource(previousSample, sample)) return null;
    const previousErrors = finiteMetric(errorSelector(previousSample));
    const currentErrors = finiteMetric(errorSelector(sample));
    const previousRequests = finiteMetric(requestSelector(samples[index - 1]));
    const currentRequests = finiteMetric(requestSelector(sample));
    if (previousErrors === null || currentErrors === null || previousRequests === null || currentRequests === null) return null;
    const errorDelta = currentErrors - previousErrors;
    const requestDelta = currentRequests - previousRequests;
    if (errorDelta < 0 || requestDelta <= 0) return null;
    return Math.min(100, Math.max(0, (errorDelta / requestDelta) * 100));
  });
}

export function appendDashboardSample(samples: readonly NacosDashboardSample[], sample: NacosDashboardSample, maxSamples = MAX_NACOS_DASHBOARD_SAMPLES): NacosDashboardSample[] {
  const next = [...samples, sample];
  return next.length > maxSamples ? next.slice(next.length - maxSamples) : next;
}

export function ratioPercent(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(100, value <= 1 ? value * 100 : value);
}

export function formatDashboardPercent(value: number | undefined): string {
  const percent = ratioPercent(value);
  return percent === null ? "—" : `${percent.toFixed(1)}%`;
}

export function isHealthyNacosNode(node: { alive?: boolean; state?: string }): boolean {
  if (typeof node.alive === "boolean") return node.alive;
  return ["UP", "ONLINE", "HEALTHY"].includes(node.state?.trim().toUpperCase() ?? "");
}
