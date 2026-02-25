/**
 * Generate a cryptographically secure random string (hex).
 */
export declare function randomHex(bytes: number): string;
/**
 * Generate a JWT-like key (base64url, 32 bytes = 256 bits).
 */
export declare function generateJwtSecret(): string;
/**
 * Generate an anon/service_role key.
 * These are just random tokens used as API keys.
 */
export declare function generateApiKey(): string;
