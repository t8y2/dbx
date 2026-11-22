const passwordAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!_";

export function generateDatabaseUserPassword(): string {
  const randomBytes = new Uint8Array(24);
  let password: string;
  // A 64-character alphabet makes each byte's six low bits a uniform choice.
  // Resample until the password contains all four common policy character classes.
  do {
    crypto.getRandomValues(randomBytes);
    password = Array.from(randomBytes, (byte) => passwordAlphabet[byte & 63]).join("");
  } while (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[!_]/.test(password));
  return password;
}
