// Salesforce OAuth metadata persisted on `ConnectionConfig.external_config.auth`.
// The backend owns encryption/storage of refreshToken; the frontend only keeps
// enough state to re-render the connection card and re-authorize when needed.

export type SalesforceAuthMode = "token" | "oauth" | "device";

export type SalesforceEnvironment = "production" | "sandbox" | "custom";

export interface SalesforceOAuthToken {
  accessToken: string;
  refreshToken?: string;
  instanceUrl: string;
}

// Backend `SfRefreshedToken`: instanceUrl is absent when Salesforce did not
// echo it on the refresh grant (callers keep their known instance URL).
export interface SalesforceOAuthRefreshResult {
  accessToken: string;
  refreshToken?: string;
  instanceUrl?: string;
}

export interface SalesforceOAuthAuthorizeParams {
  environment: SalesforceEnvironment;
  loginUrl?: string;
  clientId: string;
  clientSecret?: string;
}

export interface SalesforceOAuthDeviceStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSecs: number;
  expiresInSecs: number;
}

export type SalesforceOAuthDevicePollResult = { status: "pending"; intervalSecs: number } | { status: "success"; token: SalesforceOAuthToken } | { status: "expired" } | { status: "denied"; reason?: string };

export interface SalesforceAuthContext {
  mode: SalesforceAuthMode;
  environment?: SalesforceEnvironment;
  loginUrl?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  authorizedAt?: string;
}

export interface SalesforceExternalConfig {
  auth?: SalesforceAuthContext;
}

export const SALESFORCE_OAUTH_CALLBACK_URL = "http://localhost:27098/callback";
