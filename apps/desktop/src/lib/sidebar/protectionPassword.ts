import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

/**
 * Protection passwords are a web-only feature. The desktop build never locks,
 * prompts, or renders password UI: a local user owns the data files on disk
 * and could strip a stored verifier straight from the local database, so the
 * gate adds no protection there. Verifiers that arrive via data created in
 * the web app are simply ignored on desktop.
 *
 * Hashing and verification live entirely in the backend
 * (`dbx-core::persistence::protection_password`, argon2 with a per-item
 * random salt): the frontend only forwards the plaintext to the
 * set/verify/clear commands and never sees the stored verifier again.
 */
export function isProtectionPasswordFeatureActive(): boolean {
  return !isTauriRuntime();
}
