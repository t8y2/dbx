import type { KvPrometheusMetrics } from "@/lib/backend/tauri";

type NumericMetricKey = Exclude<
  {
    [K in keyof KvPrometheusMetrics]: KvPrometheusMetrics[K] extends number | null | undefined ? K : never;
  }[keyof KvPrometheusMetrics],
  undefined
>;

type MetricMapKey = Exclude<
  {
    [K in keyof KvPrometheusMetrics]: KvPrometheusMetrics[K] extends Record<string, number> ? K : never;
  }[keyof KvPrometheusMetrics],
  undefined
>;

function finiteMetric(metrics: KvPrometheusMetrics | null | undefined, key: NumericMetricKey): number | null {
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function comparableWindowSeconds(current: KvPrometheusMetrics, previous: KvPrometheusMetrics | null | undefined): number | null {
  if (!previous || current.sourceUrl !== previous.sourceUrl) return null;
  const currentTime = finiteMetric(current, "collectedAtMs");
  const previousTime = finiteMetric(previous, "collectedAtMs");
  if (currentTime == null || previousTime == null || currentTime <= previousTime) return null;
  return (currentTime - previousTime) / 1000;
}

export function counterRate(current: KvPrometheusMetrics | null | undefined, previous: KvPrometheusMetrics | null | undefined, key: NumericMetricKey): number | null {
  if (!current?.available || !previous?.available) return null;
  const seconds = comparableWindowSeconds(current, previous);
  const currentValue = finiteMetric(current, key);
  const previousValue = finiteMetric(previous, key);
  if (seconds == null || currentValue == null || previousValue == null || currentValue < previousValue) return null;
  return (currentValue - previousValue) / seconds;
}

export function histogramAverageMilliseconds(current: KvPrometheusMetrics | null | undefined, previous: KvPrometheusMetrics | null | undefined, sumKey: NumericMetricKey, countKey: NumericMetricKey): number | null {
  if (!current?.available) return null;
  const currentSum = finiteMetric(current, sumKey);
  const currentCount = finiteMetric(current, countKey);
  if (currentSum == null || currentCount == null || currentCount <= 0) return null;

  const previousSum = finiteMetric(previous, sumKey);
  const previousCount = finiteMetric(previous, countKey);
  const hasComparableWindow = comparableWindowSeconds(current, previous) != null;
  if (hasComparableWindow && previousSum != null && previousCount != null && currentSum >= previousSum && currentCount > previousCount) {
    return ((currentSum - previousSum) / (currentCount - previousCount)) * 1000;
  }
  return (currentSum / currentCount) * 1000;
}

export function ratePercentage(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return Math.min(100, Math.max(0, (numerator / denominator) * 100));
}

export function counterMapRates(current: KvPrometheusMetrics | null | undefined, previous: KvPrometheusMetrics | null | undefined, key: MetricMapKey): Record<string, number> {
  if (!current?.available || !previous?.available) return {};
  const seconds = comparableWindowSeconds(current, previous);
  const currentValues = current[key];
  const previousValues = previous[key];
  if (seconds == null || !currentValues || !previousValues) return {};

  return Object.fromEntries(
    Object.entries(currentValues).flatMap(([name, currentValue]) => {
      const previousValue = previousValues[name];
      return Number.isFinite(currentValue) && Number.isFinite(previousValue) && currentValue >= previousValue ? [[name, (currentValue - previousValue) / seconds]] : [];
    }),
  );
}

export function histogramMapAverageMilliseconds(current: KvPrometheusMetrics | null | undefined, previous: KvPrometheusMetrics | null | undefined, sumKey: MetricMapKey, countKey: MetricMapKey): Record<string, number> {
  if (!current?.available) return {};
  const currentSums = current[sumKey];
  const currentCounts = current[countKey];
  if (!currentSums || !currentCounts) return {};
  const previousSums = previous?.[sumKey];
  const previousCounts = previous?.[countKey];
  const useDelta = comparableWindowSeconds(current, previous) != null;

  return Object.fromEntries(
    Object.entries(currentSums).flatMap(([name, currentSum]) => {
      const currentCount = currentCounts[name];
      if (!Number.isFinite(currentSum) || !Number.isFinite(currentCount) || currentCount <= 0) return [];
      const previousSum = previousSums?.[name];
      const previousCount = previousCounts?.[name];
      if (useDelta && Number.isFinite(previousSum) && Number.isFinite(previousCount) && currentSum >= previousSum! && currentCount > previousCount!) {
        return [[name, ((currentSum - previousSum!) / (currentCount - previousCount!)) * 1000]];
      }
      return [[name, (currentSum / currentCount) * 1000]];
    }),
  );
}
