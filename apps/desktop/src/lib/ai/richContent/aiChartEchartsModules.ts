/**
 * The single source of truth for which ECharts modules the AI chart renderer
 * registers.
 *
 * It lives in a module of its own for one reason: the renderer and the
 * render-level spec must agree. A chart type whose ECharts module is missing does
 * not fail loudly — `MarkLineComponent` draws nothing at all with no warning, and
 * a cartesian heatmap throws only at render time — so a drift between "the
 * option builder emits X" and "the renderer registered X" is invisible until a
 * user sees a blank or crashed card. Keeping one list means adding a chart type
 * forces the registration to be considered in one place.
 *
 * Do NOT import this from the protocol or option layers: they must stay free of
 * ECharts runtime code so validation can be unit-tested without it.
 */

import { BarChart, FunnelChart, HeatmapChart, LineChart, PictorialBarChart, PieChart, ScatterChart } from "echarts/charts";
import { AriaComponent, DataZoomComponent, GridComponent, LegendComponent, MarkLineComponent, TitleComponent, TooltipComponent, VisualMapContinuousComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

export const AI_CHART_ECHARTS_MODULES = [
  CanvasRenderer,
  // one per supported chart type
  LineChart,
  BarChart,
  PieChart,
  PictorialBarChart,
  ScatterChart,
  HeatmapChart,
  FunnelChart,
  // components
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  // markLine fails SILENTLY when this is missing: no dashes, no labels, no warning.
  MarkLineComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  // Heatmap without a visualMap throws "Heatmap must use with visualMap"; the
  // continuous-only variant is enough and saves ~8 KB over the aggregate.
  VisualMapContinuousComponent,
] as const;
