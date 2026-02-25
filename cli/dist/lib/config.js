import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
const DEFAULT_CONFIG = {
    projectName: "pgstack-app",
    dbPort: 15432,
    proxyPort: 3000,
    pgVersion: "16",
    schemas: ["public"],
};
/**
 * Find the project root by walking up from cwd looking for pgstack.config.json
 */
export function findProjectRoot(from) {
    let dir = from ?? process.cwd();
    const root = resolve(dir, "/");
    while (dir !== root) {
        if (existsSync(resolve(dir, "pgstack.config.json"))) {
            return dir;
        }
        dir = dirname(dir);
    }
    return null;
}
/**
 * Load pgstack.config.json from the project root
 */
export async function loadConfig(projectRoot) {
    const root = projectRoot ?? findProjectRoot();
    if (!root) {
        throw new Error("Not a pgStack project. Run `pgstack init <name>` first.");
    }
    const configPath = resolve(root, "pgstack.config.json");
    if (!existsSync(configPath)) {
        return { ...DEFAULT_CONFIG };
    }
    const raw = await readFile(configPath, "utf-8");
    const userConfig = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...userConfig };
}
/**
 * Resolve DATABASE_URL from .env or environment
 */
export function getDatabaseUrl(projectRoot) {
    const envUrl = process.env.DATABASE_URL;
    if (envUrl)
        return envUrl;
    // Try loading .env from project root
    const root = projectRoot ?? findProjectRoot();
    if (root) {
        const envPath = resolve(root, ".env");
        if (existsSync(envPath)) {
            // Lazy-load dotenv
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                require("dotenv").config({ path: envPath });
                if (process.env.DATABASE_URL)
                    return process.env.DATABASE_URL;
            }
            catch {
                // dotenv not available, skip
            }
        }
    }
    return "postgres://postgres:postgres@127.0.0.1:15432/app";
}
//# sourceMappingURL=config.js.map