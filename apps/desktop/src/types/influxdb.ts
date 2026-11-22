export type InfluxDbVersion = "1" | "2" | "3";

export interface InfluxDbExternalConfig {
  version?: InfluxDbVersion;
  org?: string;
  /**
   * Path prefix for deployments behind a reverse proxy that serves
   * InfluxDB under a sub path, e.g. "/influxdb". Empty means the server is
   * reached at the root of the configured host and port.
   */
  basePath?: string;
}
