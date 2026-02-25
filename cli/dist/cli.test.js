import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// ---- Helpers ----
let tempDir;
function pgstack(...args) {
    const cliPath = join(__dirname, "..", "dist", "index.js");
    return execFileSync("node", [cliPath, ...args], {
        cwd: tempDir,
        encoding: "utf-8",
        timeout: 15000,
        env: { ...process.env, NO_COLOR: "1" },
    });
}
function readJson(path) {
    return JSON.parse(readFileSync(path, "utf-8"));
}
beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pgstack-test-"));
});
afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
// ---- Tests ----
describe("pgstack init", () => {
    it("creates project directory with all expected files", () => {
        pgstack("init", "myapp");
        const projectDir = join(tempDir, "myapp");
        expect(existsSync(projectDir)).toBe(true);
        expect(existsSync(join(projectDir, "pgstack.config.json"))).toBe(true);
        expect(existsSync(join(projectDir, "docker-compose.yml"))).toBe(true);
        expect(existsSync(join(projectDir, ".env"))).toBe(true);
        expect(existsSync(join(projectDir, ".env.example"))).toBe(true);
        expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);
        expect(existsSync(join(projectDir, "seed.sql"))).toBe(true);
        expect(existsSync(join(projectDir, "migrations"))).toBe(true);
        expect(existsSync(join(projectDir, "types"))).toBe(true);
    });
    it("generates valid pgstack.config.json with correct project name", () => {
        pgstack("init", "test-project");
        const config = readJson(join(tempDir, "test-project", "pgstack.config.json"));
        expect(config.projectName).toBe("test-project");
        expect(config.dbPort).toBe(15432);
        expect(config.proxyPort).toBe(3000);
        expect(config.pgVersion).toBe("16");
        expect(config.schemas).toEqual(["public"]);
    });
    it("generates .env with unique secrets", () => {
        pgstack("init", "app1");
        pgstack("init", "app2");
        const env1 = readFileSync(join(tempDir, "app1", ".env"), "utf-8");
        const env2 = readFileSync(join(tempDir, "app2", ".env"), "utf-8");
        const extractKey = (env, key) => {
            const match = env.match(new RegExp(`^${key}=(.+)$`, "m"));
            return match?.[1];
        };
        // JWT secrets should be different between projects
        expect(extractKey(env1, "JWT_SECRET")).not.toBe(extractKey(env2, "JWT_SECRET"));
        expect(extractKey(env1, "ANON_KEY")).not.toBe(extractKey(env2, "ANON_KEY"));
        expect(extractKey(env1, "SERVICE_ROLE_KEY")).not.toBe(extractKey(env2, "SERVICE_ROLE_KEY"));
    });
    it("generates .env with DATABASE_URL", () => {
        pgstack("init", "dbapp");
        const env = readFileSync(join(tempDir, "dbapp", ".env"), "utf-8");
        expect(env).toContain("DATABASE_URL=postgres://postgres:postgres@127.0.0.1:15432/app");
    });
    it("generates docker-compose.yml with proxy and db services", () => {
        pgstack("init", "dcapp");
        const dc = readFileSync(join(tempDir, "dcapp", "docker-compose.yml"), "utf-8");
        expect(dc).toContain("services:");
        expect(dc).toContain("db:");
        expect(dc).toContain("proxy:");
        expect(dc).toContain("postgres:16-bookworm");
        expect(dc).toContain("JWT_SECRET");
        expect(dc).toContain("ANON_KEY");
        expect(dc).toContain("SERVICE_ROLE_KEY");
    });
    it("creates bootstrap migration with auth schema", () => {
        pgstack("init", "migapp");
        const migDir = join(tempDir, "migapp", "migrations");
        const files = existsSync(migDir)
            ? readFileSync(join(migDir, "00000000000000_pgstack_init.sql"), "utf-8")
            : "";
        expect(files).toContain("CREATE SCHEMA IF NOT EXISTS pgstack");
        expect(files).toContain("pgstack.users");
        expect(files).toContain("pgstack.refresh_tokens");
        expect(files).toContain("pgstack.sessions");
        expect(files).toContain("CREATE ROLE anon NOLOGIN");
        expect(files).toContain("CREATE ROLE authenticated NOLOGIN");
        expect(files).toContain("CREATE ROLE service_role NOLOGIN BYPASSRLS");
    });
    it(".gitignore excludes .env and generated types", () => {
        pgstack("init", "gitapp");
        const gi = readFileSync(join(tempDir, "gitapp", ".gitignore"), "utf-8");
        expect(gi).toContain(".env");
        expect(gi).toContain("node_modules/");
        expect(gi).toContain("types/database.ts");
    });
    it("fails if directory already exists", () => {
        pgstack("init", "existing");
        expect(() => pgstack("init", "existing")).toThrow();
    });
    it("supports --dir option", () => {
        pgstack("init", "subproject", "--dir", tempDir);
        expect(existsSync(join(tempDir, "subproject", "pgstack.config.json"))).toBe(true);
    });
});
describe("pgstack migration create", () => {
    it("creates a timestamped migration file", () => {
        pgstack("init", "migtest");
        const projectDir = join(tempDir, "migtest");
        const output = execFileSync("node", [join(__dirname, "..", "dist", "index.js"), "migration", "create", "add_products"], {
            cwd: projectDir,
            encoding: "utf-8",
            timeout: 15000,
            env: { ...process.env, NO_COLOR: "1" },
        });
        // Should mention the file was created
        expect(output.toLowerCase()).toContain("created");
        // Check migration file exists with expected name pattern
        const migDir = join(projectDir, "migrations");
        const { readdirSync } = require("node:fs");
        const files = readdirSync(migDir);
        const newMig = files.find((f) => f.endsWith("_add_products.sql") && f !== "00000000000000_pgstack_init.sql");
        expect(newMig).toBeDefined();
        // File should have placeholder content
        const content = readFileSync(join(migDir, newMig), "utf-8");
        expect(content.length).toBeGreaterThan(0);
    });
});
describe("pgstack --version", () => {
    it("prints version", () => {
        const output = pgstack("--version");
        expect(output.trim()).toMatch(/\d+\.\d+\.\d+/);
    });
});
describe("pgstack --help", () => {
    it("shows available commands", () => {
        const output = pgstack("--help");
        expect(output).toContain("init");
        expect(output).toContain("dev");
        expect(output).toContain("migration");
        expect(output).toContain("generate");
    });
});
//# sourceMappingURL=cli.test.js.map