import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
function composeArgs(opts, ...args) {
    const result = ["compose"];
    if (opts.file) {
        result.push("-f", opts.file);
    }
    result.push(...args);
    return result;
}
export async function composeUp(opts) {
    const { stdout, stderr } = await execFileAsync("docker", composeArgs(opts, "up", "-d", "--build", "--wait"), { cwd: opts.cwd, timeout: 120_000 });
    return stdout + stderr;
}
export async function composeDown(opts) {
    const { stdout, stderr } = await execFileAsync("docker", composeArgs(opts, "down"), { cwd: opts.cwd, timeout: 30_000 });
    return stdout + stderr;
}
export function composeLogs(opts) {
    return spawn("docker", composeArgs(opts, "logs", "-f", "--tail=50"), {
        cwd: opts.cwd,
        stdio: "inherit",
    });
}
export async function composeExec(opts, service, command) {
    const { stdout, stderr } = await execFileAsync("docker", composeArgs(opts, "exec", "-T", service, ...command), { cwd: opts.cwd, timeout: 60_000 });
    return stdout + stderr;
}
export async function composePsql(opts, sql, dbName = "postgres") {
    return composeExec(opts, "db", [
        "psql",
        "-U",
        "postgres",
        "-d",
        dbName,
        "-c",
        sql,
    ]);
}
export function composePsqlInteractive(opts, dbName = "postgres") {
    return spawn("docker", composeArgs(opts, "exec", "db", "psql", "-U", "postgres", "-d", dbName), { cwd: opts.cwd, stdio: "inherit" });
}
export async function isDockerRunning() {
    try {
        await execFileAsync("docker", ["info"], { timeout: 5_000 });
        return true;
    }
    catch {
        return false;
    }
}
export async function isComposeUp(opts) {
    try {
        const { stdout } = await execFileAsync("docker", composeArgs(opts, "ps", "--format", "json"), { cwd: opts.cwd, timeout: 5_000 });
        return stdout.trim().length > 0;
    }
    catch {
        return false;
    }
}
/**
 * Run `docker compose ps --format json` and return parsed container entries.
 * Docker Compose v2 outputs one JSON object per line (JSON Lines format).
 */
export async function composePsJson(opts) {
    try {
        const { stdout } = await execFileAsync("docker", composeArgs(opts, "ps", "--format", "json"), { cwd: opts.cwd, timeout: 10_000 });
        const trimmed = stdout.trim();
        if (!trimmed)
            return [];
        // Docker Compose v2 outputs JSON Lines (one object per line).
        // Older versions may output a JSON array — handle both.
        if (trimmed.startsWith("[")) {
            return JSON.parse(trimmed);
        }
        return trimmed
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line));
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=docker.js.map