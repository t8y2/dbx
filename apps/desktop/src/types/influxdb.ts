export type InfluxDbVersion = "1" | "2";

export interface InfluxDbExternalConfig {
  version?: InfluxDbVersion;
  org?: string;
}
