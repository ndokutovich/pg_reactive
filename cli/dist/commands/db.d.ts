import { Command } from "commander";
export declare function registerDbCommand(program: Command): void;
/**
 * Sanitize a branch name to be a valid PG identifier.
 * Allows alphanumeric, underscore, and hyphen only.
 */
export declare function sanitizeBranchName(name: string): string;
