<!--
Thanks for the PR. Most fields are optional — the security-tagged
checklist at the bottom is NOT. The trust matrix in SECURITY.md is
the single source of truth for this project; security-touching PRs
that don't update it get sent back.
-->

## What this PR does

<!-- One paragraph. The "why" matters more than the "what" — code review
fills in the what. -->

## How to test

<!-- Steps a reviewer can run locally to verify. Skip if unit tests
fully cover. -->

## Linked

<!-- Issue / audit-round / external report this PR addresses. -->

---

## Security-tagged PR checklist (REQUIRED for any change touching auth, RLS, grants, secrets, networking, JWT, OAuth, CSP/HSTS, edge functions, storage, or anything in `SECURITY.md`)

If your PR touches any of the above, ALL three of the following MUST
be true before merge. Reviewers refuse PRs that skip these.

- [ ] **Added one negative regression test** in `tests/security/` (or
  a `*_test.go` next to the code) that fails against the pre-fix
  state and passes after. Reference the audit round / SECURITY.md
  invariant number in the test header.
- [ ] **Updated [SECURITY.md](../SECURITY.md)** — either a row in the
  trust matrix changes, a new row is added, or a new cross-cutting
  invariant joins the list. If the change has no row to touch, the
  matrix has a gap and YOU are filling it.
- [ ] **(when the class allows it) Added a lint rule** in
  `tests/lint/security_patterns.mjs`. If the mistake can be matched
  by grep or AST, codify it so the next contributor can't make it
  again.

If none of the above apply (truly non-security change), check this
single box instead:

- [ ] Not security-touching — no audit invariants affected.

---

## Other change types

- [ ] Breaking change (consumers need to update)
- [ ] Migration added (new file in `migrations/`)
- [ ] Documentation updated (`docs/site/docs/`, `SECURITY.md`, `README.md`)
- [ ] `cli/dist` rebuilt and committed if `cli/src` changed
- [ ] `cli/templates/bootstrap-core.sql` re-synced if `docker/init.sql` core region changed
