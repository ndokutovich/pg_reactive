import { randomBytes } from "node:crypto";

/**
 * Generate a cryptographically secure random string (hex).
 */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Generate a JWT-like key (base64url, 32 bytes = 256 bits).
 */
export function generateJwtSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Generate an anon/service_role key.
 * These are just random tokens used as API keys.
 */
export function generateApiKey(): string {
  return randomBytes(32).toString("base64url");
}
