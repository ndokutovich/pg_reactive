# Version inventory

What runs, at which version, and whether that version is still alive.

```
node scripts/versions/check.mjs            # snapshot + freshness (EOL fatal)
node scripts/versions/check.mjs --strict   # also fail when behind the latest patch
node scripts/versions/check.mjs --offline  # snapshot only, no network
node scripts/versions/check.mjs --write    # regenerate docs/VERSIONS.md
```

## Pieces

- **`inventory.mjs`** — collects every pin that decides what runs: Dockerfile
  `FROM` bases, CI toolchains (`node-version`, `go-version`, `toolchain`), and
  compose `image:` lines. One row per `(runtime, version, source)`.
- **`check.mjs`** — two independent checks. *Snapshot*: the committed
  `docs/VERSIONS.md` must equal the tree (deterministic, runs on every push).
  *Freshness*: each pin is compared with the `endoflife.date` feed for its own
  cycle (runs on a schedule).
- **`rules.json`** — **not** a list of versions to match. It holds only what a
  CVE bulletin pins more precisely than "latest", plus branches declared dead
  by hand (`"eol"`). The normal threshold comes from the feed.

## States

| State | Meaning | Gate |
|---|---|---|
| `ok` | last patch of a live branch | — |
| `stale` | behind the last patch, and we can fix it | fatal with `--strict` |
| `eol` | branch is dead; no patch is coming | **always fatal** |
| `floating` | only a major/minor is pinned (a moving Docker tag) | informational |
| `unknown` | the feed does not know the cycle | informational |

`floating` is not a loophole: it says the patch level is the registry's choice,
not ours. Pin a full version when the exact patch matters.

## Adding a runtime

Add an entry to `RUNTIMES` in `inventory.mjs` with the image repo (registry
stripped) and how its cycle is derived — `major`, `minor`, or `codename`.
`feed` is the product id used by `endoflife.date/api/<product>.json`.
