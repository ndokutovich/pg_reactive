import { execFile, spawn, ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ComposePsEntry {
  Name: string;
  Service: string;
  Status: string;
  Health: string;
  State: string;
  ExitCode: number;
}

export interface DockerComposeOptions {
  cwd: string;
  file?: string;
}

function composeArgs(opts: DockerComposeOptions, ...args: string[]): string[] {
  const result = ["compose"];
  if (opts.file) {
    result.push("-f", opts.file);
  }
  result.push(...args);
  return result;
}

export async function composeUp(opts: DockerComposeOptions): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    "docker",
    composeArgs(opts, "up", "-d", "--build", "--wait"),
    { cwd: opts.cwd, timeout: 120_000 }
  );
  return stdout + stderr;
}

export async function composeDown(opts: DockerComposeOptions): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    "docker",
    composeArgs(opts, "down"),
    { cwd: opts.cwd, timeout: 30_000 }
  );
  return stdout + stderr;
}

export function composeLogs(opts: DockerComposeOptions): ChildProcess {
  return spawn("docker", composeArgs(opts, "logs", "-f", "--tail=50"), {
    cwd: opts.cwd,
    stdio: "inherit",
  });
}

export async function composeExec(
  opts: DockerComposeOptions,
  service: string,
  command: string[]
): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    "docker",
    composeArgs(opts, "exec", "-T", service, ...command),
    { cwd: opts.cwd, timeout: 60_000 }
  );
  return stdout + stderr;
}

export async function composePsql(
  opts: DockerComposeOptions,
  sql: string,
  dbName: string = "postgres"
): Promise<string> {
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

export function composePsqlInteractive(
  opts: DockerComposeOptions,
  dbName: string = "postgres"
): ChildProcess {
  return spawn(
    "docker",
    composeArgs(opts, "exec", "db", "psql", "-U", "postgres", "-d", dbName),
    { cwd: opts.cwd, stdio: "inherit" }
  );
}

export async function isDockerRunning(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function isComposeUp(opts: DockerComposeOptions): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      composeArgs(opts, "ps", "--format", "json"),
      { cwd: opts.cwd, timeout: 5_000 }
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Run `docker compose ps --format json` and return parsed container entries.
 * Docker Compose v2 outputs one JSON object per line (JSON Lines format).
 */
export async function composePsJson(
  opts: DockerComposeOptions
): Promise<ComposePsEntry[]> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      composeArgs(opts, "ps", "--format", "json"),
      { cwd: opts.cwd, timeout: 10_000 }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];

    // Docker Compose v2 outputs JSON Lines (one object per line).
    // Older versions may output a JSON array — handle both.
    if (trimmed.startsWith("[")) {
      return JSON.parse(trimmed) as ComposePsEntry[];
    }
    return trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ComposePsEntry);
  } catch {
    return [];
  }
}
