import type { ClickHouseFunctionDefinition, ClickHouseFunctionSignature } from "./functionTypes";
import { CLICKHOUSE_WINDOW_FUNCTION_NAMES } from "./regularFunctions";

/**
 * Static aggregate-function snapshot verified against the official ClickHouse
 * Playground on 2026-07-31. Runtime completion never queries a server.
 */
const CLICKHOUSE_AGGREGATE_NAMES =
  "aggThrow analysisOfVariance any any_respect_nulls anyHeavy anyLast anyLast_respect_nulls approx_top_k approx_top_sum argAndMax argAndMin argMax argMin avg avgWeighted boundingRatio categoricalInformationValue contingency corr corrMatrix corrStable count covarPop covarPopMatrix covarPopStable covarSamp covarSampMatrix covarSampStable cramersV cramersVBiasCorrected cume_dist deltaSum deltaSumTimestamp denseRank distinctDynamicTypes distinctJSONPaths distinctJSONPathsAndTypes entropy estimateCompressionRatio exponentialMovingAverage exponentialTimeDecayedAvg exponentialTimeDecayedCount exponentialTimeDecayedMax exponentialTimeDecayedSum flameGraph groupArray groupArrayInsertAt groupArrayIntersect groupArrayLast groupArrayMovingAvg groupArrayMovingSum groupArraySample groupArraySorted groupBitAnd groupBitmap groupBitmapAnd groupBitmapOr groupBitmapXor groupBitOr groupBitXor groupConcat groupFormat groupNumericIndexedVector groupUniqArray histogram intervalLengthSum kolmogorovSmirnovTest kurtPop kurtSamp lag lagInFrame largestTriangleThreeBuckets lead leadInFrame mannWhitneyUTest max maxIntersections maxIntersectionsPosition maxMappedArrays meanZTest min minMappedArrays MVTEncode nonNegativeDerivative nothing nothingNull nothingUInt64 nth_value ntile percentRank quantile quantileBFloat16 quantileBFloat16Weighted quantileDD quantileDeterministic quantileExact quantileExactExclusive quantileExactHigh quantileExactInclusive quantileExactLow quantileExactWeighted quantileExactWeightedInterpolated quantileGK quantileInterpolatedWeighted quantilePrometheusHistogram quantiles quantilesBFloat16 quantilesBFloat16Weighted quantilesDD quantilesDeterministic quantilesExact quantilesExactExclusive quantilesExactHigh quantilesExactInclusive quantilesExactLow quantilesExactWeighted quantilesExactWeightedInterpolated quantilesGK quantilesInterpolatedWeighted quantilesPrometheusHistogram quantilesTDigest quantilesTDigestWeighted quantilesTiming quantilesTimingWeighted quantileTDigest quantileTDigestWeighted quantileTiming quantileTimingWeighted rank rankCorr retention row_number sequenceCount sequenceMatch sequenceMatchEvents sequenceNextNode simpleLinearRegression singleValueOrNull skewPop skewSamp sparkbar stddevPop stddevPopStable stddevSamp stddevSampStable stochasticLinearRegression stochasticLogisticRegression studentTTest studentTTestOneSample sum sumCount sumKahan sumMapFiltered sumMapFilteredWithOverflow sumMappedArrays sumMapWithOverflow sumWithOverflow theilsU timeSeriesChangesToGrid timeSeriesDeltaToGrid timeSeriesDerivToGrid timeSeriesGroupArray timeSeriesInstantDeltaToGrid timeSeriesInstantRateToGrid timeSeriesLastTwoSamples timeSeriesPredictLinearToGrid timeSeriesRateToGrid timeSeriesResampleToGridWithStaleness timeSeriesResetsToGrid topK topKWeighted uniq uniqCombined uniqCombined64 uniqExact uniqHLL12 uniqTheta uniqUpTo varPop varPopStable varSamp varSampStable welchTTest windowFunnel";

const CLICKHOUSE_AGGREGATE_ALIASES: Record<string, string[]> = {
  analysisOfVariance: ["anova"],
  any: ["any_value"],
  any_respect_nulls: ["any_value_respect_nulls", "anyRespectNulls", "anyValueRespectNulls", "first_value_respect_nulls", "firstValueRespectNulls"],
  anyLast_respect_nulls: ["anyLastRespectNulls", "last_value_respect_nulls", "lastValueRespectNulls"],
  approx_top_k: ["approx_top_count"],
  argMax: ["max_by"],
  argMin: ["min_by"],
  covarPop: ["COVAR_POP"],
  covarSamp: ["COVAR_SAMP"],
  groupArray: ["array_agg"],
  groupBitAnd: ["BIT_AND"],
  groupBitOr: ["BIT_OR"],
  groupBitXor: ["BIT_XOR"],
  groupConcat: ["group_concat", "string_agg"],
  largestTriangleThreeBuckets: ["lttb"],
  MVTEncode: ["ST_AsMVT"],
  quantile: ["median"],
  quantileBFloat16: ["medianBFloat16"],
  quantileBFloat16Weighted: ["medianBFloat16Weighted"],
  quantileDD: ["medianDD"],
  quantileDeterministic: ["medianDeterministic"],
  quantileExact: ["medianExact"],
  quantileExactHigh: ["medianExactHigh"],
  quantileExactLow: ["medianExactLow"],
  quantileExactWeighted: ["medianExactWeighted"],
  quantileExactWeightedInterpolated: ["medianExactWeightedInterpolated"],
  quantileGK: ["medianGK"],
  quantileInterpolatedWeighted: ["medianInterpolatedWeighted"],
  quantileTDigest: ["medianTDigest"],
  quantileTDigestWeighted: ["medianTDigestWeighted"],
  quantileTiming: ["medianTiming"],
  quantileTimingWeighted: ["medianTimingWeighted"],
  stddevPop: ["STD", "STDDEV_POP"],
  stddevSamp: ["STDDEV", "STDDEV_SAMP"],
  timeSeriesResampleToGridWithStaleness: ["timeSeriesLastToGrid"],
  varPop: ["VAR_POP"],
  varSamp: ["VAR_SAMP"],
};

const sig = (...parameterGroups: string[][]): ClickHouseFunctionSignature => ({ parameterGroups });

const SIGNATURE_OVERRIDES: Record<string, ClickHouseFunctionSignature[]> = {
  count: [sig([]), sig(["expression"])],
  sum: [sig(["value"])],
  sumWithOverflow: [sig(["value"])],
  avg: [sig(["value"])],
  min: [sig(["value"])],
  max: [sig(["value"])],
  any: [sig(["value"])],
  anyLast: [sig(["value"])],
  anyHeavy: [sig(["value"])],
  argMin: [sig(["argument", "value"])],
  argMax: [sig(["argument", "value"])],
  groupArray: [sig(["expression"]), sig(["max_size"], ["expression"])],
  groupUniqArray: [sig(["expression"]), sig(["max_size"], ["expression"])],
  groupArrayArray: [sig(["array"])],
  groupArrayInsertAt: [sig(["default_value?", "size?"]), sig(["value", "position"])],
  groupConcat: [sig(["delimiter?", "limit?"]), sig(["expression"])],
  uniq: [sig(["expression", "...expressions"])],
  uniqExact: [sig(["expression", "...expressions"])],
  uniqCombined: [sig(["HLL_precision?"]), sig(["expression", "...expressions"])],
  uniqCombined64: [sig(["HLL_precision?"]), sig(["expression", "...expressions"])],
  uniqHLL12: [sig(["expression", "...expressions"])],
  uniqTheta: [sig(["expression", "...expressions"])],
  quantile: [sig(["level?"]), sig(["expression"])],
  quantiles: [sig(["level", "...levels"], ["expression"])],
  quantileExact: [sig(["level?"]), sig(["expression"])],
  quantilesExact: [sig(["level", "...levels"], ["expression"])],
  quantileTDigest: [sig(["level?"]), sig(["expression"])],
  quantilesTDigest: [sig(["level", "...levels"], ["expression"])],
  quantileTiming: [sig(["level?"]), sig(["expression"])],
  quantilesTiming: [sig(["level", "...levels"], ["expression"])],
  quantileBFloat16: [sig(["level?"]), sig(["expression"])],
  quantilesBFloat16: [sig(["level", "...levels"], ["expression"])],
  median: [sig(["level?"]), sig(["expression"])],
  topK: [sig(["N?", "load_factor?", "counts?"]), sig(["expression"])],
  topKWeighted: [sig(["N?", "load_factor?", "counts?"]), sig(["expression", "weight"])],
  histogram: [sig(["bins"]), sig(["values"])],
  sequenceMatch: [sig(["pattern"]), sig(["timestamp", "...conditions"])],
  sequenceCount: [sig(["pattern"]), sig(["timestamp", "...conditions"])],
  windowFunnel: [sig(["window", "mode?"]), sig(["timestamp", "...conditions"])],
  retention: [sig(["condition", "...conditions"])],
};

const aggregate = (name: string): ClickHouseFunctionDefinition => {
  const signatures = Object.prototype.hasOwnProperty.call(SIGNATURE_OVERRIDES, name) ? SIGNATURE_OVERRIDES[name] : [sig(["expression", "...expressions?"])];
  const aliases = Object.prototype.hasOwnProperty.call(CLICKHOUSE_AGGREGATE_ALIASES, name) ? CLICKHOUSE_AGGREGATE_ALIASES[name] : undefined;
  return {
    name,
    kind: "aggregate",
    category: "aggregate",
    signatures,
    aliases,
    combinators: true,
  };
};

export const CLICKHOUSE_AGGREGATE_FUNCTIONS: ClickHouseFunctionDefinition[] = CLICKHOUSE_AGGREGATE_NAMES.split(" ")
  .filter(Boolean)
  .filter((name) => !CLICKHOUSE_WINDOW_FUNCTION_NAMES.has(name))
  .map(aggregate);
