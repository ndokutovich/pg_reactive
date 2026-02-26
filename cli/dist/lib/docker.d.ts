import { ChildProcess } from "node:child_process";
export interface DockerComposeOptions {
    cwd: string;
    file?: string;
}
export declare function composeUp(opts: DockerComposeOptions): Promise<string>;
export declare function composeDown(opts: DockerComposeOptions): Promise<string>;
export declare function composeLogs(opts: DockerComposeOptions): ChildProcess;
export declare function composeExec(opts: DockerComposeOptions, service: string, command: string[]): Promise<string>;
export declare function composePsql(opts: DockerComposeOptions, sql: string, dbName?: string): Promise<string>;
export declare function composePsqlInteractive(opts: DockerComposeOptions, dbName?: string): ChildProcess;
export declare function isDockerRunning(): Promise<boolean>;
export declare function isComposeUp(opts: DockerComposeOptions): Promise<boolean>;
