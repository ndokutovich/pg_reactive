import { execFile, spawn, ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  sql: string
): Promise<string> {
  return composeExec(opts, "db", [
    "psql",
    "-U",
    "postgres",
    "-d",
    "app",
    "-c",
    sql,
  ]);
}

export function composePsqlInteractive(
  opts: DockerComposeOptions
): ChildProcess {
  return spawn(
    "docker",
    composeArgs(opts, "exec", "db", "psql", "-U", "postgres", "-d", "app"),
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
