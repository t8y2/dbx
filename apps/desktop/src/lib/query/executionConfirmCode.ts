/**
 * Confirmation code shown in the "confirm target execution" prompt of a
 * multi-database batch: the operator has to type it back before the batch is
 * allowed to run, so a mis-click cannot fire the same statement at every
 * connection.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const EXECUTION_CONFIRM_CODE_LENGTH = 6;

export function createExecutionConfirmCode(random: () => number = Math.random, length = EXECUTION_CONFIRM_CODE_LENGTH): string {
  const size = Math.max(1, Math.trunc(length));
  let code = "";
  for (let index = 0; index < size; index += 1) {
    const value = random();
    const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999_999) : 0;
    code += CODE_ALPHABET[Math.floor(normalized * CODE_ALPHABET.length)] ?? CODE_ALPHABET[0];
  }
  return code;
}

/** Typed input matches the displayed code, ignoring case and surrounding spaces. */
export function matchesExecutionConfirmCode(input: string, code: string): boolean {
  if (!code) return false;
  return input.trim().toUpperCase() === code.trim().toUpperCase();
}
