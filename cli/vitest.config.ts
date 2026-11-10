import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The `pgstack init` integration tests spawn the built CLI as a child
    // process (cold Node start + scaffolding many files). Under CI load — the
    // multi-arch image candidate plus the other parallel jobs share the VM —
    // that cold start blew vitest's 5s default and flaked the first init test.
    // 20s gives the spawn-based tests headroom; a genuine hang still fails the
    // suite well within CI's job timeout.
    testTimeout: 20000,
  },
});
