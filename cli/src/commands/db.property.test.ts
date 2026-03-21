/**
 * Property-based tests for sanitizeBranchName using fast-check v4.
 *
 * Each test encodes a universal contract that must hold for ALL inputs
 * in the described input domain, not just the handful of examples in db.test.ts.
 */

import { describe, it } from "vitest";
import * as fc from "fast-check";
import { sanitizeBranchName } from "./db.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Characters that survive the sanitizer unchanged. */
const VALID_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

/** Characters that are always stripped by the sanitizer. */
const INVALID_CHARS = "!@#$%^&*()+=[]{}|;:,.<>?/ \t\n\\\"'`~";

const validCharArb = fc.constantFrom(...VALID_CHARS.split(""));
const invalidCharArb = fc.constantFrom(...INVALID_CHARS.split(""));

/** A non-empty string composed only of valid characters. */
const onlyValidStr = fc.string({ unit: validCharArb, minLength: 1 });

/** A non-empty string composed only of invalid characters. */
const onlyInvalidStr = fc.string({ unit: invalidCharArb, minLength: 1 });

/**
 * A string that contains at least one valid character somewhere, mixed with
 * any number of invalid characters before, after, or in the middle.
 */
const mixedWithAtLeastOneValidStr = fc
  .tuple(
    fc.string({ unit: invalidCharArb }),   // leading noise (may be empty)
    fc.string({ unit: validCharArb, minLength: 1 }), // guaranteed valid core
    fc.string({ unit: invalidCharArb }),   // trailing noise (may be empty)
  )
  .map(([pre, core, post]) => pre + core + post);

// ---------------------------------------------------------------------------
// Property 1 — Idempotency
//
// Applying sanitize to its own output must return the same string.
// The first call strips all invalid chars; a second call finds nothing to strip.
// ---------------------------------------------------------------------------

describe("sanitizeBranchName — property: idempotency", () => {
  it("sanitize(sanitize(x)) === sanitize(x) for any non-throwing input", () => {
    fc.assert(
      fc.property(mixedWithAtLeastOneValidStr, (input) => {
        const once = sanitizeBranchName(input);
        const twice = sanitizeBranchName(once);
        return once === twice;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 — Output charset invariant
//
// Every character in the result must be in [a-zA-Z0-9_-].
// ---------------------------------------------------------------------------

describe("sanitizeBranchName — property: output charset invariant", () => {
  it("result contains only [a-zA-Z0-9_-] characters", () => {
    const allowedRe = /^[a-zA-Z0-9_-]+$/;

    fc.assert(
      fc.property(mixedWithAtLeastOneValidStr, (input) => {
        const result = sanitizeBranchName(input);
        return allowedRe.test(result);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3 — Length monotonicity
//
// The sanitizer can only remove characters; it never inserts new ones.
// ---------------------------------------------------------------------------

describe("sanitizeBranchName — property: length monotonicity", () => {
  it("result.length <= input.length", () => {
    fc.assert(
      fc.property(mixedWithAtLeastOneValidStr, (input) => {
        const result = sanitizeBranchName(input);
        return result.length <= input.length;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 — Identity on valid input
//
// When every character in the input is already valid, the function returns
// the input unchanged.
// ---------------------------------------------------------------------------

describe("sanitizeBranchName — property: identity on valid input", () => {
  it("sanitize(x) === x when x consists entirely of valid characters", () => {
    fc.assert(
      fc.property(onlyValidStr, (input) => {
        return sanitizeBranchName(input) === input;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5 — Non-empty guarantee
//
// If the input contains at least one valid character, the result must be
// non-empty (the function does not throw).
// ---------------------------------------------------------------------------

describe("sanitizeBranchName — property: non-empty guarantee", () => {
  it("does not throw and returns non-empty string when input has at least one valid char", () => {
    fc.assert(
      fc.property(mixedWithAtLeastOneValidStr, (input) => {
        const result = sanitizeBranchName(input);
        return result.length > 0;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6 — Throws on all-invalid input
//
// If every character in the input is an invalid character, sanitizeBranchName
// must throw an Error containing "Invalid branch name".
// ---------------------------------------------------------------------------

describe("sanitizeBranchName — property: throws on all-invalid input", () => {
  it("throws when the input contains zero valid characters", () => {
    fc.assert(
      fc.property(onlyInvalidStr, (input) => {
        let threw = false;
        try {
          sanitizeBranchName(input);
        } catch (err) {
          threw = true;
          if (!(err instanceof Error)) return false;
          if (!err.message.includes("Invalid branch name")) return false;
        }
        return threw;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7 — Preserves valid substring (relative order)
//
// Every valid character from the input appears in the output in the same
// relative order (the output is a subsequence of the input restricted to
// valid characters).
// ---------------------------------------------------------------------------

describe("sanitizeBranchName — property: preserves valid substring in order", () => {
  it("all valid chars from input appear in output in the same relative order", () => {
    fc.assert(
      fc.property(mixedWithAtLeastOneValidStr, (input) => {
        const expected = input.replace(/[^a-zA-Z0-9_-]/g, "");
        const result = sanitizeBranchName(input);
        return result === expected;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8 — Case preservation
//
// The sanitizer must not alter the case of any letter it retains.
// Uppercase letters remain uppercase; lowercase letters remain lowercase.
// ---------------------------------------------------------------------------

describe("sanitizeBranchName — property: case preservation", () => {
  it("uppercase letters in input remain uppercase in output", () => {
    const upperCharArb = fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));
    const upperStr = fc.string({ unit: upperCharArb, minLength: 1 });

    fc.assert(
      fc.property(upperStr, (input) => {
        const result = sanitizeBranchName(input);
        // All chars are already valid so result === input (identity)
        // but we verify the case contract explicitly
        return result === result.toUpperCase();
      }),
    );
  });

  it("lowercase letters in input remain lowercase in output", () => {
    const lowerCharArb = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split(""));
    const lowerStr = fc.string({ unit: lowerCharArb, minLength: 1 });

    fc.assert(
      fc.property(lowerStr, (input) => {
        const result = sanitizeBranchName(input);
        return result === result.toLowerCase();
      }),
    );
  });

  it("mixed-case input retains the case of each individual letter", () => {
    fc.assert(
      fc.property(onlyValidStr, (input) => {
        const result = sanitizeBranchName(input);
        // Identity holds for all-valid input, so case is trivially preserved.
        // Re-check character-by-character for clarity.
        for (let i = 0; i < result.length; i++) {
          const c = result[i];
          // Find the matching character position in the original input.
          // Since identity holds for all-valid input, result === input.
          if (c !== input[i]) return false;
        }
        return true;
      }),
    );
  });
});
