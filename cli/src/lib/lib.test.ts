import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomHex, generateJwtSecret, generateApiKey } from "./crypto.js";
import { findProjectRoot, loadConfig } from "./config.js";
import { pgTypeToTs } from "./pg.js";

// ---- crypto ----

describe("crypto", () => {
  it("randomHex generates correct length", () => {
    expect(randomHex(16).length).toBe(32); // 16 bytes = 32 hex chars
    expect(randomHex(32).length).toBe(64);
  });

  it("randomHex generates unique values", () => {
    const a = randomHex(16);
    const b = randomHex(16);
    expect(a).not.toBe(b);
  });

  it("generateJwtSecret returns base64url string", () => {
    const secret = generateJwtSecret();
    expect(secret.length).toBeGreaterThan(30);
    // base64url chars: A-Z, a-z, 0-9, -, _
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generateApiKey returns base64url string", () => {
    const key = generateApiKey();
    expect(key.length).toBeGreaterThan(30);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates unique keys each time", () => {
    const keys = new Set(Array.from({ length: 10 }, () => generateApiKey()));
    expect(keys.size).toBe(10);
  });
});

// ---- config ----

describe("findProjectRoot", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pgstack-config-test-"));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("finds root when config exists in same directory", () => {
    writeFileSync(
      join(tempDir, "pgstack.config.json"),
      '{"projectName":"test"}'
    );
    const root = findProjectRoot(tempDir);
    expect(root).toBe(tempDir);
  });

  it("returns null when no config found", () => {
    const root = findProjectRoot(tempDir);
    expect(root).toBeNull();
  });
});

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pgstack-config-test-"));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads config with defaults merged", async () => {
    writeFileSync(
      join(tempDir, "pgstack.config.json"),
      '{"projectName":"custom"}'
    );
    const config = await loadConfig(tempDir);
    expect(config.projectName).toBe("custom");
    expect(config.dbPort).toBe(15432); // default
    expect(config.proxyPort).toBe(3000); // default
  });

  it("returns defaults for empty config", async () => {
    writeFileSync(join(tempDir, "pgstack.config.json"), "{}");
    const config = await loadConfig(tempDir);
    expect(config.projectName).toBe("pgstack-app");
    expect(config.schemas).toEqual(["public"]);
  });
});

// ---- pg type mapping ----

describe("pgTypeToTs", () => {
  it("maps boolean types", () => {
    expect(pgTypeToTs("bool", "boolean")).toBe("boolean");
  });

  it("maps numeric types", () => {
    expect(pgTypeToTs("int4", "integer")).toBe("number");
    expect(pgTypeToTs("int8", "bigint")).toBe("number");
    expect(pgTypeToTs("float4", "real")).toBe("number");
    expect(pgTypeToTs("float8", "double precision")).toBe("number");
    expect(pgTypeToTs("numeric", "numeric")).toBe("number");
  });

  it("maps string types", () => {
    expect(pgTypeToTs("text", "text")).toBe("string");
    expect(pgTypeToTs("varchar", "character varying")).toBe("string");
    expect(pgTypeToTs("uuid", "uuid")).toBe("string");
  });

  it("maps JSON types", () => {
    expect(pgTypeToTs("json", "json")).toBe("Json");
    expect(pgTypeToTs("jsonb", "jsonb")).toBe("Json");
  });

  it("maps date/time types to string", () => {
    expect(pgTypeToTs("timestamptz", "timestamp with time zone")).toBe("string");
    expect(pgTypeToTs("timestamp", "timestamp without time zone")).toBe("string");
    expect(pgTypeToTs("date", "date")).toBe("string");
  });

  it("maps USER-DEFINED types to string", () => {
    expect(pgTypeToTs("somecustom", "USER-DEFINED")).toBe("string");
  });

  it("maps ARRAY types to unknown[]", () => {
    expect(pgTypeToTs("_int4", "ARRAY")).toBe("unknown[]");
  });

  it("maps truly unknown types to unknown", () => {
    expect(pgTypeToTs("somecustom", "somecustom")).toBe("unknown");
  });
});
