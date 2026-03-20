import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDatabaseName, findProjectRoot } from './lib/config.js';
import { pgTypeToTs } from './lib/pg.js';
import { randomHex, generateJwtSecret, generateApiKey } from './lib/crypto.js';

// ---- Arbitraries ----

/** Valid database name: alphanumeric with underscores, starts with a letter, 1-30 chars. */
const dbNameArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,29}$/);

/** Valid postgres user:password combo (no special URL chars). */
const credentialsArb = fc
  .tuple(
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,15}$/),
    fc.stringMatching(/^[a-zA-Z0-9]{1,20}$/),
  )
  .map(([user, pass]) => `${user}:${pass}`);

/** Valid hostname. */
const hostArb = fc.stringMatching(/^[a-z][a-z0-9.-]{0,30}$/);

/** Valid port number. */
const portArb = fc.integer({ min: 1, max: 65535 });

/** Full postgres URL built from components. */
const postgresUrlArb = fc
  .tuple(credentialsArb, hostArb, portArb, dbNameArb)
  .map(([creds, host, port, db]) => `postgres://${creds}@${host}:${port}/${db}`);

/** Postgres URL with optional query params. */
const postgresUrlWithParamsArb = fc
  .tuple(
    postgresUrlArb,
    fc.constantFrom('', '?sslmode=require', '?sslmode=disable&connect_timeout=10'),
  )
  .map(([url, params]) => url + params);

/** Known PG numeric types. */
const numericUdtArb = fc.constantFrom('int2', 'int4', 'int8', 'float4', 'float8', 'numeric');

/** Known PG string types. */
const stringUdtArb = fc.constantFrom(
  'uuid', 'text', 'varchar', 'char', 'bpchar', 'name', 'citext',
  'inet', 'cidr', 'macaddr', 'bytea',
);

/** Known PG date/time types. */
const dateUdtArb = fc.constantFrom('timestamptz', 'timestamp', 'date', 'time', 'timetz');

/** Known PG JSON types. */
const jsonUdtArb = fc.constantFrom('json', 'jsonb');

/** All known types that map to a definite TypeScript type. */
const knownUdtArb = fc.oneof(
  fc.constant('bool'),
  numericUdtArb,
  stringUdtArb,
  dateUdtArb,
  jsonUdtArb,
);

/** SQL-like identifier (for table/column names). */
const identifierArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,19}$/);

/** Non-negative byte count for randomHex. */
const byteLenArb = fc.integer({ min: 1, max: 64 });

/** pgstack.config.json content. */
const configArb = fc
  .record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
    dbPort: fc.integer({ min: 1024, max: 65535 }),
    proxyPort: fc.integer({ min: 1024, max: 65535 }),
    pgVersion: fc.constantFrom('14', '15', '16', '17'),
    schemas: fc.array(identifierArb, { minLength: 1, maxLength: 3 }),
  })
  .filter((c) => c.dbPort !== c.proxyPort); // ports must differ

// ---- Property Tests: parseDatabaseName ----

describe('parseDatabaseName property-based tests', () => {
  // Property 1: For any well-formed postgres URL, parseDatabaseName extracts
  // the database name from the path component.
  it('extracts database name from any valid postgres URL', () => {
    fc.assert(
      fc.property(postgresUrlArb, (url) => {
        const dbName = parseDatabaseName(url);
        // Must be a non-empty string
        expect(dbName.length).toBeGreaterThan(0);
        // Must not contain slashes or query params
        expect(dbName).not.toContain('/');
        expect(dbName).not.toContain('?');
      }),
      { numRuns: 200 },
    );
  });

  // Property 2: The extracted name matches the name we built the URL with.
  it('round-trips: extracted name matches the input db name', () => {
    fc.assert(
      fc.property(
        credentialsArb,
        hostArb,
        portArb,
        dbNameArb,
        (creds, host, port, dbName) => {
          const url = `postgres://${creds}@${host}:${port}/${dbName}`;
          expect(parseDatabaseName(url)).toBe(dbName);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Property 3: Query parameters after the database name are stripped.
  it('strips query parameters from database name', () => {
    fc.assert(
      fc.property(postgresUrlWithParamsArb, (url) => {
        const dbName = parseDatabaseName(url);
        expect(dbName).not.toContain('?');
        expect(dbName).not.toContain('=');
      }),
      { numRuns: 200 },
    );
  });

  // Property 4: URL without a database path throws.
  it('throws for URL without database path', () => {
    fc.assert(
      fc.property(credentialsArb, hostArb, portArb, (creds, host, port) => {
        const url = `postgres://${creds}@${host}:${port}`;
        expect(() => parseDatabaseName(url)).toThrow();
      }),
      { numRuns: 50 },
    );
  });
});

// ---- Property Tests: pgTypeToTs ----

describe('pgTypeToTs property-based tests', () => {
  // Property 5: All known UDT names produce a recognized TypeScript type
  // (never "unknown").
  it('all known UDT names map to a concrete TS type', () => {
    fc.assert(
      fc.property(knownUdtArb, fc.string(), (udt, dataType) => {
        const result = pgTypeToTs(udt, dataType);
        expect(['boolean', 'number', 'string', 'Json']).toContain(result);
      }),
      { numRuns: 200 },
    );
  });

  // Property 6: Boolean type always maps to "boolean".
  it('bool always maps to boolean', () => {
    fc.assert(
      fc.property(fc.string(), (dataType) => {
        expect(pgTypeToTs('bool', dataType)).toBe('boolean');
      }),
      { numRuns: 50 },
    );
  });

  // Property 7: All numeric UDT names map to "number".
  it('numeric UDT names always map to number', () => {
    fc.assert(
      fc.property(numericUdtArb, fc.string(), (udt, dataType) => {
        expect(pgTypeToTs(udt, dataType)).toBe('number');
      }),
      { numRuns: 100 },
    );
  });

  // Property 8: JSON types always map to "Json".
  it('json/jsonb always map to Json', () => {
    fc.assert(
      fc.property(jsonUdtArb, fc.string(), (udt, dataType) => {
        expect(pgTypeToTs(udt, dataType)).toBe('Json');
      }),
      { numRuns: 50 },
    );
  });

  // Property 9: ARRAY data type maps to "unknown[]" regardless of udt_name.
  it('ARRAY data type maps to unknown[]', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^_[a-z]{1,10}$/), // PG ARRAY udt names start with _
        (udt) => {
          expect(pgTypeToTs(udt, 'ARRAY')).toBe('unknown[]');
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property 10: USER-DEFINED data type maps to "string" for unknown udt names.
  it('USER-DEFINED maps to string for non-standard udt names', () => {
    // Use udt names that are NOT in the known sets
    const unknownUdtArb = fc.stringMatching(/^custom_[a-z]{1,10}$/);

    fc.assert(
      fc.property(unknownUdtArb, (udt) => {
        expect(pgTypeToTs(udt, 'USER-DEFINED')).toBe('string');
      }),
      { numRuns: 100 },
    );
  });

  // Property 11: Return type is always one of the known set.
  it('return type is always in the valid set', () => {
    const anyUdtArb = fc.stringMatching(/^[a-z_][a-z0-9_]{0,15}$/);
    const anyDataTypeArb = fc.stringMatching(/^[A-Za-z_ -]{1,30}$/);
    const validResults = ['boolean', 'number', 'string', 'Json', 'unknown', 'unknown[]'];

    fc.assert(
      fc.property(anyUdtArb, anyDataTypeArb, (udt, dataType) => {
        const result = pgTypeToTs(udt, dataType);
        expect(validResults).toContain(result);
      }),
      { numRuns: 200 },
    );
  });
});

// ---- Property Tests: crypto functions ----

describe('crypto property-based tests', () => {
  // Property 12: randomHex produces exactly 2*N hex chars.
  it('randomHex(n) produces a string of exactly 2n hex characters', () => {
    fc.assert(
      fc.property(byteLenArb, (n) => {
        const hex = randomHex(n);
        expect(hex.length).toBe(n * 2);
        expect(hex).toMatch(/^[0-9a-f]+$/);
      }),
      { numRuns: 100 },
    );
  });

  // Property 13: randomHex produces unique values (probabilistic but extremely reliable).
  // Uses minimum 8 bytes (2^64 possible values) so collision in 10 calls is negligible.
  it('randomHex produces unique values across multiple calls', () => {
    const safeByteLenArb = fc.integer({ min: 8, max: 64 });
    fc.assert(
      fc.property(safeByteLenArb, (n) => {
        const values = new Set(Array.from({ length: 10 }, () => randomHex(n)));
        expect(values.size).toBe(10);
      }),
      { numRuns: 50 },
    );
  });

  // Property 14: generateJwtSecret always produces base64url string of consistent length.
  it('generateJwtSecret produces valid base64url string', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const secret = generateJwtSecret();
        // 32 bytes base64url = 43 chars (ceil(32*4/3) without padding)
        expect(secret.length).toBe(43);
        expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
      }),
      { numRuns: 50 },
    );
  });

  // Property 15: generateApiKey always produces base64url string of consistent length.
  it('generateApiKey produces valid base64url string', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const key = generateApiKey();
        expect(key.length).toBe(43);
        expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
      }),
      { numRuns: 50 },
    );
  });

  // Property 16: JWT secrets and API keys never collide.
  it('JWT secrets and API keys are distinct', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const secret = generateJwtSecret();
        const key = generateApiKey();
        expect(secret).not.toBe(key);
      }),
      { numRuns: 100 },
    );
  });
});

// ---- Property Tests: findProjectRoot ----

describe('findProjectRoot property-based tests', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    tempDirs = [];
  });

  // Property 17: When config exists in a directory, findProjectRoot returns that directory.
  it('finds root when pgstack.config.json exists at the given path', () => {
    fc.assert(
      fc.property(configArb, (config) => {
        const dir = mkdtempSync(join(tmpdir(), 'pgstack-prop-'));
        tempDirs.push(dir);
        writeFileSync(join(dir, 'pgstack.config.json'), JSON.stringify(config));
        const root = findProjectRoot(dir);
        expect(root).toBe(dir);
      }),
      { numRuns: 20 },
    );
  });

  // Property 18: When no config exists, findProjectRoot returns null.
  it('returns null when no config file is present', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const dir = mkdtempSync(join(tmpdir(), 'pgstack-empty-'));
        tempDirs.push(dir);
        const root = findProjectRoot(dir);
        expect(root).toBeNull();
      }),
      { numRuns: 10 },
    );
  });
});

// ---- Property Tests: toPascalCase (via generate.ts behavior) ----

describe('toPascalCase property-based tests', () => {
  // The toPascalCase function is not exported, but we can reimplement and test
  // the invariant: snake_case -> PascalCase
  function toPascalCase(snake: string): string {
    return snake
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }

  // Property 19: PascalCase result never contains underscores.
  it('result never contains underscores', () => {
    fc.assert(
      fc.property(identifierArb, (snake) => {
        const pascal = toPascalCase(snake);
        expect(pascal).not.toContain('_');
      }),
      { numRuns: 200 },
    );
  });

  // Property 20: PascalCase result starts with uppercase letter.
  it('result starts with uppercase letter', () => {
    fc.assert(
      fc.property(identifierArb, (snake) => {
        const pascal = toPascalCase(snake);
        expect(pascal.charAt(0)).toMatch(/[A-Z]/);
      }),
      { numRuns: 200 },
    );
  });

  // Property 21: Length of result <= length of input (underscores removed).
  it('result length equals input length minus underscores', () => {
    fc.assert(
      fc.property(identifierArb, (snake) => {
        const pascal = toPascalCase(snake);
        const underscoreCount = (snake.match(/_/g) || []).length;
        expect(pascal.length).toBe(snake.length - underscoreCount);
      }),
      { numRuns: 200 },
    );
  });

  // Property 22: Each segment's first letter is capitalized in the result.
  it('each word segment starts with uppercase in result', () => {
    fc.assert(
      fc.property(identifierArb, (snake) => {
        const segments = snake.split('_').filter((s) => s.length > 0);
        const pascal = toPascalCase(snake);

        let offset = 0;
        for (const seg of segments) {
          if (seg.length > 0) {
            expect(pascal.charAt(offset)).toBe(seg.charAt(0).toUpperCase());
            offset += seg.length;
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
