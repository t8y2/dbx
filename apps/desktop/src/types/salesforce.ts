// Salesforce OAuth metadata persisted on `ConnectionConfig.external_config.auth`.
// The backend owns encryption/storage of refreshToken; the frontend only keeps
// enough state to re-render the connection card and re-authorize when needed.

export type SalesforceAuthMode = "token" | "oauth" | "device" | "password";

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
  // Username-password (ROPC) mode. The password is scrubbed into the backend
  // secret store (key salesforce.auth.password) and never rendered back.
  username?: string;
  password?: string;
  authorizedAt?: string;
}

export interface SalesforceExternalConfig {
  auth?: SalesforceAuthContext;
}

/**
 * Identity of the user a Salesforce connection is authenticated as, resolved from
 * `GET /services/oauth2/userinfo` plus a `Profile.PermissionsModifyAllData` probe.
 * Returned by the `salesforce_current_user` command / `GET /api/salesforce/current-user`.
 *
 * `isAdmin` is advisory only (a permission set can grant fine-grained rights), so it
 * drives a UI hint and never a security decision — Salesforce enforces the real rules.
 * The backend omits `isAdmin` / `profileName` when the probe did not resolve, so both
 * are optional; fields Salesforce did not return come back as empty strings.
 */
export interface SalesforceCurrentUser {
  userId: string;
  name: string;
  email: string;
  organizationId: string;
  username: string;
  profileName?: string;
  isAdmin?: boolean | null;
  /** Org display name (`SELECT Name FROM Organization`), falling back to the instance host. */
  orgName: string;
}

export const SALESFORCE_OAUTH_CALLBACK_URL = "http://localhost:27098/callback";
