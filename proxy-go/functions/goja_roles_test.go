package functions

import "testing"

// Round 47 M6 (external codex review): the goja db.query() whitelist silently
// demoted `anonymous` guests to anon — fail-closed, but a violation of the
// edge-function matrix promise to run with the CALLER's RLS context, and it
// made guest-only policies unreachable from embedded functions. The whitelist
// must carry every data-plane role the proxies mint.
func TestGojaRoleWhitelistCoversAllDataRoles(t *testing.T) {
	for _, r := range []string{"anon", "anonymous", "authenticated", "service_role"} {
		if _, ok := gojaValidRoles[r]; !ok {
			t.Fatalf("gojaValidRoles missing %q — a guest would silently demote to anon (round 47 M6)", r)
		}
	}
}
