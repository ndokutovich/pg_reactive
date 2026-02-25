export interface PgStackConfig {
    projectName: string;
    dbPort: number;
    proxyPort: number;
    pgVersion: string;
    schemas: string[];
}
/**
 * Find the project root by walking up from cwd looking for pgstack.config.json
 */
export declare function findProjectRoot(from?: string): string | null;
/**
 * Load pgstack.config.json from the project root
 */
export declare function loadConfig(projectRoot?: string): Promise<PgStackConfig>;
/**
 * Resolve DATABASE_URL from .env or environment
 */
export declare function getDatabaseUrl(projectRoot?: string): string;
