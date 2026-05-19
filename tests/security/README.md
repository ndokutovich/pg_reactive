# Adversarial security fixtures

Every test in this directory is **negative**: it asserts that the
proxy / SDK / extension REFUSES a specific attack. The names follow
`{class}__{specific_attack}.test.mjs`.

This is the "one negative regression test per audit finding" half of
the ritual codified in [`SECURITY.md`](../../SECURITY.md). When
adding tests here:

- The test MUST fail against the pre-fix commit and pass against the
  post-fix commit. If both pass, the test is documenting nothing; if
  both fail, the fix isn't in.
- Cross-reference the audit round number and SECURITY.md invariant
  number in the test header so future readers know what gate this
  guards.
- Prefer black-box HTTP-level assertions (matches what an attacker
  sees) over white-box code-level mocks (matches what the developer
  remembers writing).

Many earlier audit findings already have in-tree regression coverage
next to the code (e.g. `proxy-go/auth/jwt_empty_secret_test.go`,
`proxy-go/middleware/composition_test.go`,
`proxy-go/functions/http_validate_test.go`). Those stay where they
are — this directory is for cross-cutting / black-box checks that
don't fit naturally in any one package.

## Running

```bash
docker compose up -d
for t in tests/security/*.test.mjs; do node "$t" || break; done
```

CI runs them automatically as part of the `Adversarial security`
job (see `.github/workflows/ci.yml`).
