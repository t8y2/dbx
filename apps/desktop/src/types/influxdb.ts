export type InfluxDbVersion = "1" | "2" | "3";

export interface InfluxDbExternalConfig {
  version?: InfluxDbVersion;
  org?: string;
}
