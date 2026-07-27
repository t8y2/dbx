import { describe, expect, it } from "vitest";
import { appendDashboardSample, averageDurationMsSeries, counterRateSeries, dashboardMetric, dashboardNamespaceLabel, dashboardSeries, errorRateSeries, formatDashboardPercent, isHealthyNacosNode, ratioPercent, type NacosDashboardSample } from "@/lib/nacos/nacosDashboard";

function sample(at: number, metrics: NacosDashboardSample["snapshot"]["metrics"]): NacosDashboardSample {
  return {
    at,
    snapshot: {
      namespace: "",
      metrics,
      nodes: [],
      warnings: [],
    },
  };
}

describe("nacosDashboard helpers", () => {
  it("reads metric series and leaves gaps for missing values", () => {
    const samples = [sample(1, { serviceCount: 2 }), sample(2, { serviceCount: 5 }), sample(3, undefined)];
    expect(dashboardMetric(samples[1], "serviceCount")).toBe(5);
    expect(dashboardSeries(samples, "serviceCount")).toEqual([2, 5, null]);
  });

  it("calculates rates and leaves gaps after counter resets", () => {
    const samples = [
      { ...sample(1_000, {}), snapshot: { ...sample(1_000, {}).snapshot, prometheus: { source: { kind: "nacos" as const, endpoint: "http://metrics" }, resource: {}, traffic: { httpRequestsTotal: 10 }, config: {}, naming: {} } } },
      { ...sample(3_000, {}), snapshot: { ...sample(3_000, {}).snapshot, prometheus: { source: { kind: "nacos" as const, endpoint: "http://metrics" }, resource: {}, traffic: { httpRequestsTotal: 20 }, config: {}, naming: {} } } },
      { ...sample(5_000, {}), snapshot: { ...sample(5_000, {}).snapshot, prometheus: { source: { kind: "nacos" as const, endpoint: "http://metrics" }, resource: {}, traffic: { httpRequestsTotal: 2 }, config: {}, naming: {} } } },
    ];
    expect(counterRateSeries(samples, (item) => item.snapshot.prometheus?.traffic.httpRequestsTotal)).toEqual([null, 5, null]);
  });

  it("leaves counter-derived gaps when the Prometheus source changes", () => {
    const samples: NacosDashboardSample[] = [
      {
        ...sample(1_000, {}),
        snapshot: {
          ...sample(1_000, {}).snapshot,
          prometheus: { source: { kind: "nacos", endpoint: "http://metrics-a" }, resource: {}, traffic: { httpRequestsTotal: 10, httpErrorsTotal: 1, httpDurationSecondsTotal: 1, httpDurationCount: 10 }, config: {}, naming: {} },
        },
      },
      {
        ...sample(2_000, {}),
        snapshot: {
          ...sample(2_000, {}).snapshot,
          prometheus: { source: { kind: "nacos", endpoint: "http://metrics-b" }, resource: {}, traffic: { httpRequestsTotal: 100, httpErrorsTotal: 20, httpDurationSecondsTotal: 50, httpDurationCount: 100 }, config: {}, naming: {} },
        },
      },
    ];
    expect(counterRateSeries(samples, (item) => item.snapshot.prometheus?.traffic.httpRequestsTotal)).toEqual([null, null]);
    expect(
      averageDurationMsSeries(
        samples,
        (item) => item.snapshot.prometheus?.traffic.httpDurationSecondsTotal,
        (item) => item.snapshot.prometheus?.traffic.httpDurationCount,
      ),
    ).toEqual([null, null]);
    expect(
      errorRateSeries(
        samples,
        (item) => item.snapshot.prometheus?.traffic.httpErrorsTotal,
        (item) => item.snapshot.prometheus?.traffic.httpRequestsTotal,
      ),
    ).toEqual([null, null]);
  });

  it("uses the private source fingerprint when redacted endpoints match", () => {
    const samples: NacosDashboardSample[] = [
      {
        ...sample(1_000, {}),
        snapshot: {
          ...sample(1_000, {}).snapshot,
          prometheus: { source: { kind: "nacos", endpoint: "http://metrics", fingerprint: "source-a" }, resource: {}, traffic: { httpRequestsTotal: 10 }, config: {}, naming: {} },
        },
      },
      {
        ...sample(2_000, {}),
        snapshot: {
          ...sample(2_000, {}).snapshot,
          prometheus: { source: { kind: "nacos", endpoint: "http://metrics", fingerprint: "source-b" }, resource: {}, traffic: { httpRequestsTotal: 20 }, config: {}, naming: {} },
        },
      },
    ];
    expect(counterRateSeries(samples, (item) => item.snapshot.prometheus?.traffic.httpRequestsTotal)).toEqual([null, null]);
  });

  it("calculates average latency and error percentage from counter deltas", () => {
    const samples: NacosDashboardSample[] = [
      {
        ...sample(1_000, {}),
        snapshot: {
          ...sample(1_000, {}).snapshot,
          prometheus: { source: { kind: "nacos", endpoint: "http://metrics" }, resource: {}, traffic: { httpRequestsTotal: 100, httpErrorsTotal: 2, httpDurationSecondsTotal: 10, httpDurationCount: 100 }, config: {}, naming: {} },
        },
      },
      {
        ...sample(2_000, {}),
        snapshot: {
          ...sample(2_000, {}).snapshot,
          prometheus: { source: { kind: "nacos", endpoint: "http://metrics" }, resource: {}, traffic: { httpRequestsTotal: 120, httpErrorsTotal: 4, httpDurationSecondsTotal: 14, httpDurationCount: 120 }, config: {}, naming: {} },
        },
      },
    ];
    expect(
      averageDurationMsSeries(
        samples,
        (item) => item.snapshot.prometheus?.traffic.httpDurationSecondsTotal,
        (item) => item.snapshot.prometheus?.traffic.httpDurationCount,
      ),
    ).toEqual([null, 200]);
    expect(
      errorRateSeries(
        samples,
        (item) => item.snapshot.prometheus?.traffic.httpErrorsTotal,
        (item) => item.snapshot.prometheus?.traffic.httpRequestsTotal,
      ),
    ).toEqual([null, 10]);
  });

  it("keeps the newest samples within the requested limit", () => {
    let samples: NacosDashboardSample[] = [];
    for (let at = 1; at <= 4; at++) samples = appendDashboardSample(samples, sample(at, {}), 3);
    expect(samples.map((item) => item.at)).toEqual([2, 3, 4]);
  });

  it("normalizes ratio and percentage resource values", () => {
    expect(ratioPercent(0.25)).toBe(25);
    expect(ratioPercent(25)).toBe(25);
    expect(formatDashboardPercent(0.125)).toBe("12.5%");
    expect(formatDashboardPercent(undefined)).toBe("—");
  });

  it("prefers the dashboard response namespace over the requested fallback", () => {
    expect(dashboardNamespaceLabel("prod", undefined)).toBe("prod");
    expect(dashboardNamespaceLabel("", "dev")).toBe("public");
    expect(dashboardNamespaceLabel(undefined, "dev")).toBe("dev");
    expect(dashboardNamespaceLabel(undefined, undefined)).toBe("public");
  });

  it("derives node health from explicit state when alive is absent", () => {
    expect(isHealthyNacosNode({ state: "UP" })).toBe(true);
    expect(isHealthyNacosNode({ state: "DOWN" })).toBe(false);
    expect(isHealthyNacosNode({ alive: false, state: "UP" })).toBe(false);
  });
});
