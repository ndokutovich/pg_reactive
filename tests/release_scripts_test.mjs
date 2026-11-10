// Execution tests for the extracted release/deploy gate scripts (.github/scripts/).
// gemini R27 / the auditor's own conclusion: regex-analysis of inline workflow
// shell has hit its limit — the critical logic now lives in scripts that are
// tested by RUNNING them with good/bad inputs and asserting exit code + output,
// not by grepping the YAML. The supply-chain guard now only verifies the
// workflows CALL these scripts with a real shell and don't disable the step.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTS = join(process.cwd(), ".github", "scripts");
const bashPath = (p) => p.replace(/\\/g, "/"); // Git-Bash + Linux both accept forward slashes
let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`); if (!cond) fail++; };

// Run a script; return {code, out}. Never throws on non-zero exit.
function run(script, args, opts = {}) {
  try {
    const out = execFileSync("bash", [bashPath(join(SCRIPTS, script)), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
    return { code: 0, out: out.trim() };
  } catch (e) { return { code: e.status ?? 1, out: ((e.stdout || "") + (e.stderr || "")).trim() }; }
}

console.log("=== release/deploy gate scripts (executed) ===");

// ── validate-release-version.sh ──────────────────────────────────────────────
console.log("-- validate-release-version.sh --");
const wd = mkdtempSync(join(tmpdir(), "relscripts-"));
const setPkgs = (ver) => { for (const p of ["sdk", "cli"]) { mkdirSync(join(wd, p), { recursive: true }); writeFileSync(join(wd, p, "package.json"), JSON.stringify({ version: ver })); } };
// jq may be absent on a dev box (it IS on the CI runners). Inject a stub that
// extracts `.version` so the version-match logic is exercised offline; on CI
// JQ_CLI is unset and real jq runs.
const jqStub = join(wd, "jq-stub.sh");
writeFileSync(jqStub, `#!/usr/bin/env bash\nsed -n 's/.*"version"[^"]*"\\([^"]*\\)".*/\\1/p' "$3"\n`);
chmodSync(jqStub, 0o755); // the script invokes $JQ_CLI directly — needs +x on Linux (gemini R28-1)
const vEnv = { ...process.env, JQ_CLI: bashPath(jqStub) };
const runV = (args) => run("validate-release-version.sh", args, { cwd: wd, env: vEnv });
setPkgs("1.2.3");
ok(runV(["refs/tags/v1.2.3"]).out === "1.2.3", "accepts v1.2.3 (matches packages) -> 1.2.3");
ok(runV(["v1.2.3"]).code === 0, "accepts bare v1.2.3");
for (const bad of ["v1.2.3-01", "v1.2.3-.", "v1.2.3-a..b", "v1x.2.3", "v1..2.3", "v1.2.3+meta", "v01.2.3", "vfoo"])
  ok(runV([bad]).code !== 0, `rejects malformed ${bad}`);
ok(runV(["refs/tags/v1.2.4"]).code !== 0, "rejects v1.2.4 when packages are 1.2.3 (version mismatch)");
setPkgs("1.2.3-rc.1");
ok(runV(["refs/tags/v1.2.3-rc.1"]).out === "1.2.3-rc.1", "accepts a matching pre-release v1.2.3-rc.1");
setPkgs("9.9.9"); // CLI drift
writeFileSync(join(wd, "cli", "package.json"), JSON.stringify({ version: "1.0.0" }));
ok(runV(["v9.9.9"]).code !== 0, "rejects when only SDK matches and CLI drifts");
rmSync(wd, { recursive: true, force: true });

// ── npm-dist-tag.sh ───────────────────────────────────────────────────────────
console.log("-- npm-dist-tag.sh --");
ok(run("npm-dist-tag.sh", ["v1.2.3"]).out === "latest", "final v1.2.3 -> latest");
ok(run("npm-dist-tag.sh", ["refs/tags/v1.2.3"]).out === "latest", "final refs/tags/v1.2.3 -> latest");
ok(run("npm-dist-tag.sh", ["v1.2.3-rc.1"]).out === "next", "pre-release v1.2.3-rc.1 -> next (NOT latest)");
ok(run("npm-dist-tag.sh", ["v2.0.0-beta.3"]).out === "next", "pre-release v2.0.0-beta.3 -> next");

// ── compute-docker-tags.sh ────────────────────────────────────────────────────
console.log("-- compute-docker-tags.sh --");
ok(run("compute-docker-tags.sh", ["ghcr.io/x/img", "v1.2.3"]).out === "-t ghcr.io/x/img:1.2.3 -t ghcr.io/x/img:1.2 -t ghcr.io/x/img:latest", "final -> version + minor + latest");
ok(run("compute-docker-tags.sh", ["ghcr.io/x/img", "v1.2.3", "16"]).out === "-t ghcr.io/x/img:1.2.3 -t ghcr.io/x/img:1.2 -t ghcr.io/x/img:latest -t ghcr.io/x/img:16", "final + extra fixed tag (16)");
ok(run("compute-docker-tags.sh", ["ghcr.io/x/img", "v1.2.3-rc.1", "16"]).out === "-t ghcr.io/x/img:1.2.3-rc.1", "pre-release -> ONLY the exact version (no floating/16/latest)");

// ── require-green-ci.sh (gh stubbed via $GH_CLI) ──────────────────────────────
console.log("-- require-green-ci.sh --");
const ghDir = mkdtempSync(join(tmpdir(), "ghstub-"));
const mkGh = (count) => {
  const p = join(ghDir, `gh-${count}.sh`);
  // echo the args to stderr (so the test can assert the query), print the count.
  writeFileSync(p, `#!/usr/bin/env bash\necho "ARGS: $*" >&2\necho ${count}\n`);
  chmodSync(p, 0o755); // invoked directly via $GH_CLI — needs +x on Linux (gemini R28-1)
  return bashPath(p);
};
const green = run("require-green-ci.sh", ["o/r", "deadbeef"], { env: { ...process.env, GH_CLI: mkGh(1) } });
ok(green.code === 0, "exit 0 when a green CI run exists (count>=1)");
const red = run("require-green-ci.sh", ["o/r", "deadbeef"], { env: { ...process.env, GH_CLI: mkGh(0) } });
ok(red.code !== 0, "exit nonzero when NO green CI run exists (count 0)");
ok(/event=push&branch=master/.test(red.out) && /head_sha=deadbeef/.test(red.out), "passes head_sha + event=push&branch=master to gh api");
// FAIL CLOSED on malformed/empty gh output (a non-numeric count must not pass the
// `-lt 1` test fall-through as "CI is green") — gemini R29.
ok(run("require-green-ci.sh", ["o/r", "deadbeef"], { env: { ...process.env, GH_CLI: mkGh("not-a-number") } }).code !== 0, "fails closed on a NON-NUMERIC gh count");
ok(run("require-green-ci.sh", ["o/r", "deadbeef"], { env: { ...process.env, GH_CLI: mkGh("") } }).code !== 0, "fails closed on an EMPTY gh count");
rmSync(ghDir, { recursive: true, force: true });

// ── promote-image.sh + smoke-*.sh (docker stubbed via $DOCKER_CLI) ────────────
// Execute the Docker-bound scripts against a stubbed `docker` that logs its
// invocations — so replacing any of them with `exit 0` is CAUGHT (the expected
// docker calls would be missing), not merely "the file exists" (gemini R28-4).
console.log("-- promote-image.sh + smoke-*.sh (docker stubbed) --");
const dk = mkdtempSync(join(tmpdir(), "dockerstub-"));
const dockerLog = join(dk, "docker.log");
const dockerStub = join(dk, "docker.sh");
writeFileSync(dockerStub, `#!/usr/bin/env bash
echo "$*" >> "${bashPath(dockerLog)}"
case "$*" in
  *"imagetools inspect"*) echo '{"mediaType":"x","digest":"sha256:deadbeefcafe0123456789abcdef0123456789abcdef0123456789abcdef0123","size":1}' ;;
  *"SELECT extversion"*) echo "0.1.7" ;;
  *"logs"*) echo "pgstack listening (HTTP)" ;;
  *"run --rm"*) echo "PGSTACK_ENV=production: JWT_SECRET still contains 'dev-only' — generate a real key | JWT_SECRET is a publicly-known placeholder — generate a real key"; exit 1 ;;
  *) : ;;
esac
`);
chmodSync(dockerStub, 0o755);
const digestJq = join(dk, "jq-digest.sh");
writeFileSync(digestJq, `#!/usr/bin/env bash\nsed -n 's/.*"digest"[^"]*"\\([^"]*\\)".*/\\1/p'\n`);
chmodSync(digestJq, 0o755);
const dkEnv = { ...process.env, DOCKER_CLI: bashPath(dockerStub), JQ_CLI: bashPath(digestJq) };
const log = () => readFileSync(dockerLog, "utf8");
const resetLog = () => writeFileSync(dockerLog, "");
// promote: resolves the sha tag's digest and imagetools-creates the version tags.
resetLog();
const promote = run("promote-image.sh", ["ghcr.io/o/pgstack-proxy", "deadbeef", "v1.2.3"], { env: dkEnv });
ok(promote.code === 0, "promote-image.sh succeeds when the digest resolves");
ok(/imagetools create[\s\S]*pgstack-proxy:1\.2\.3[\s\S]*pgstack-proxy@sha256:/.test(log()), "promote imagetools-creates the version tag from @digest (not just exit 0)");
// TARGET_REPO mirror (Docker Hub): the digest is resolved from the GHCR repo, but
// the version tags are created on the target repo from that SAME digest.
resetLog();
const mirror = run("promote-image.sh", ["ghcr.io/o/pgstack-proxy", "deadbeef", "v1.2.3"], { env: { ...dkEnv, TARGET_REPO: "docker.io/u/pgstack-proxy" } });
ok(mirror.code === 0, "promote-image.sh mirrors to TARGET_REPO when set");
ok(/imagetools create[\s\S]*docker\.io\/u\/pgstack-proxy:1\.2\.3[\s\S]*ghcr\.io\/o\/pgstack-proxy@sha256:/.test(log()), "mirror creates docker.io tags from the GHCR @digest (same bytes, cross-registry)");
// promote fail-closed: a docker that yields no digest must abort, not promote ":".
resetLog();
const badDocker = join(dk, "docker-nodigest.sh");
writeFileSync(badDocker, `#!/usr/bin/env bash\necho "$*" >> "${bashPath(dockerLog)}"\necho '{}'\n`);
chmodSync(badDocker, 0o755);
const promoteBad = run("promote-image.sh", ["ghcr.io/o/pgstack-proxy", "deadbeef", "v1.2.3"], { env: { ...dkEnv, DOCKER_CLI: bashPath(badDocker) } });
ok(promoteBad.code !== 0, "promote-image.sh fails closed when the digest can't be resolved");
ok(!/imagetools create/.test(log()), "promote does NOT imagetools-create without a digest");
// smoke-postgres: boots both arches + creates the extension.
resetLog();
const smP = run("smoke-postgres.sh", ["ghcr.io/o/pgstack-postgres@sha256:abc"], { env: { ...process.env, DOCKER_CLI: bashPath(dockerStub) } });
ok(smP.code === 0, "smoke-postgres.sh passes against a healthy stubbed image");
ok(/run -d[\s\S]*linux\/amd64/.test(log()) && /run -d[\s\S]*linux\/arm64/.test(log()) && /CREATE EXTENSION/.test(log()), "smoke-postgres boots BOTH amd64+arm64 AND runs CREATE EXTENSION (R29: not arm64 only)");
// A classic image store cannot hold two platforms under one repo@digest
// reference: the arm64 pull fails with "cannot overwrite digest" unless the
// amd64 image is dropped first (seen on a hosted runner, 2026-11-11).
ok(/run -d[^\n]*linux\/amd64[\s\S]*rmi [^\n]*pgstack-postgres@sha256:abc[\s\S]*run -d[^\n]*linux\/arm64/.test(log()), "smoke-postgres drops the amd64 image before pulling arm64 under the same digest ref");
// smoke-proxy: runs the validator on both arches; passes because it rejects.
resetLog();
const smX = run("smoke-proxy.sh", ["ghcr.io/o/pgstack-proxy@sha256:abc"], { env: { ...process.env, DOCKER_CLI: bashPath(dockerStub) } });
ok(smX.code === 0, "smoke-proxy.sh passes when the validator rejects the placeholder secret");
ok(/run --rm[\s\S]*linux\/amd64/.test(log()) && /run --rm[\s\S]*linux\/arm64/.test(log()), "smoke-proxy runs the validator on BOTH amd64+arm64 (R29: not arm64 only)");
// smoke-proxy-rust: the Rust sibling proxy smoke — asserts the Rust validator wording.
resetLog();
const smR = run("smoke-proxy-rust.sh", ["ghcr.io/o/pgstack-proxy-rust@sha256:abc"], { env: { ...process.env, DOCKER_CLI: bashPath(dockerStub) } });
ok(smR.code === 0, "smoke-proxy-rust.sh passes when the Rust validator rejects the placeholder secret");
ok(/run --rm[\s\S]*linux\/amd64/.test(log()) && /run --rm[\s\S]*linux\/arm64/.test(log()), "smoke-proxy-rust runs the validator on BOTH amd64+arm64");
// smoke-all-in-one: boots the single container, waits for the proxy "listening"
// log line, and loads pg_reactive — on both arches.
resetLog();
const smA = run("smoke-all-in-one.sh", ["ghcr.io/o/pgstack-all-in-one@sha256:abc"], { env: { ...process.env, DOCKER_CLI: bashPath(dockerStub) } });
ok(smA.code === 0, "smoke-all-in-one.sh passes when the container boots PG + extension + proxy");
ok(/run -d[\s\S]*linux\/amd64/.test(log()) && /CREATE EXTENSION/.test(log()), "smoke-all-in-one boots amd64 AND loads pg_reactive");
rmSync(dk, { recursive: true, force: true });

if (fail) { console.error(`\nFAIL: ${fail} release-script execution test(s) failed.`); process.exit(1); }
console.log("\nPASS: all extracted release/deploy gate scripts behave correctly under execution.");
