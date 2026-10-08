import { del, get, post, put } from "@/lib/backend/http";
import type { PermissionKey } from "@/lib/auth/permissions";

export interface AdminUserRole {
  id: number;
  name: string;
}

export interface AdminUser {
  id: number;
  username: string;
  display_name: string | null;
  department_id: number | null;
  department_name: string | null;
  is_admin: boolean;
  status: number;
  must_change_password: boolean;
  password_updated_at: string | null;
  created_at: string;
  updated_at: string;
  roles: AdminUserRole[];
}

export interface AdminDepartment {
  id: number;
  name: string;
  sort: number;
  created_at: string;
  user_count: number;
}

export interface AdminScope {
  allowed_group_ids: string[];
  allowed_connection_ids: string[];
}

export interface AdminRole {
  id: number;
  name: string;
  description: string | null;
  permissions: PermissionKey[];
  scope: AdminScope;
  created_at: string;
  updated_at: string;
  user_count: number;
}

export type BlacklistKind = "ip" | "user";

export interface BlacklistEntry {
  id: number;
  kind: BlacklistKind;
  value: string;
  reason: string | null;
  created_by: number | string | null;
  created_at: string;
}

export interface ScopeTreeNode {
  type: "group" | "connection";
  id: string;
  name: string;
  children?: ScopeTreeNode[];
}

export interface ScopeTreeResponse {
  nodes: ScopeTreeNode[];
  ungrouped: ScopeTreeNode[];
}

export interface CreateAdminUserInput {
  username: string;
  password: string;
  display_name?: string;
  department_id?: number;
  role_ids?: number[];
  is_admin?: boolean;
}

export interface UpdateAdminUserInput {
  display_name?: string;
  department_id?: number | null;
  role_ids?: number[];
  status?: number;
  is_admin?: boolean;
}

export interface CreateAdminDepartmentInput {
  name: string;
  sort?: number;
}

export interface UpdateAdminDepartmentInput {
  name?: string;
  sort?: number;
}

export interface CreateAdminRoleInput {
  name: string;
  description?: string;
  permissions: PermissionKey[];
  scope: AdminScope;
}

export interface UpdateAdminRoleInput {
  name?: string;
  description?: string;
  permissions?: PermissionKey[];
  scope?: AdminScope;
}

export interface CreateBlacklistEntryInput {
  kind: BlacklistKind;
  value: string;
  reason?: string;
}

interface OkResponse {
  ok: true;
}

const adminPath = (resource: string, id?: number) => `/api/admin/${resource}${id === undefined ? "" : `/${encodeURIComponent(String(id))}`}`;

export const listAdminUsers = () => get<AdminUser[]>(adminPath("users"));
export const createAdminUser = (input: CreateAdminUserInput) => post<AdminUser>(adminPath("users"), input);
export const updateAdminUser = (id: number, input: UpdateAdminUserInput) => put<AdminUser>(adminPath("users", id), input);
export const resetAdminUserPassword = (id: number, newPassword: string) => post<OkResponse>(`${adminPath("users", id)}/reset-password`, { new_password: newPassword });
export const deleteAdminUser = (id: number) => del<OkResponse>(adminPath("users", id));

export const listAdminDepartments = () => get<AdminDepartment[]>(adminPath("departments"));
export const createAdminDepartment = (input: CreateAdminDepartmentInput) => post<AdminDepartment>(adminPath("departments"), input);
export const updateAdminDepartment = (id: number, input: UpdateAdminDepartmentInput) => put<AdminDepartment>(adminPath("departments", id), input);
export const deleteAdminDepartment = (id: number) => del<OkResponse>(adminPath("departments", id));

export const listAdminRoles = () => get<AdminRole[]>(adminPath("roles"));
export const createAdminRole = (input: CreateAdminRoleInput) => post<AdminRole>(adminPath("roles"), input);
export const updateAdminRole = (id: number, input: UpdateAdminRoleInput) => put<AdminRole>(adminPath("roles", id), input);
export const deleteAdminRole = (id: number) => del<OkResponse>(adminPath("roles", id));

export const listBlacklistEntries = () => get<BlacklistEntry[]>(adminPath("blacklist"));
export const createBlacklistEntry = (input: CreateBlacklistEntryInput) => post<BlacklistEntry>(adminPath("blacklist"), input);
export const deleteBlacklistEntry = (id: number) => del<OkResponse>(adminPath("blacklist", id));

export const getAdminScopeTree = () => get<ScopeTreeResponse>(adminPath("scope-tree"));

/** Extracts the compact error code returned by the admin endpoints. */
export function adminErrorCode(error: unknown): string | null {
  const candidates: unknown[] = [error];
  if (error && typeof error === "object" && "backendError" in error) {
    candidates.push((error as { backendError: unknown }).backendError);
  }
  if (error instanceof Error) candidates.push(error.message);

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      if (typeof record.error === "string") return record.error;
      if (typeof record.detail === "string") {
        const parsed = parseAdminError(record.detail);
        if (parsed) return parsed;
      }
    }
    if (typeof candidate === "string") {
      const parsed = parseAdminError(candidate);
      if (parsed) return parsed;
    }
  }
  return null;
}

function parseAdminError(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : null;
  } catch {
    return /^[a-z][a-z0-9_]*$/.test(value) ? value : null;
  }
}
