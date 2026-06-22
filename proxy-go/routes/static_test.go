package routes

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestSafeStaticPath_AllowsRelative(t *testing.T) {
	root, _ := filepath.Abs(t.TempDir())
	got := safeStaticPath(root, "assets/app.js")
	want := filepath.Join(root, "assets", "app.js")
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestSafeStaticPath_EmptyResolvesToIndex(t *testing.T) {
	root, _ := filepath.Abs(t.TempDir())
	got := safeStaticPath(root, "")
	want := filepath.Join(root, "index.html")
	if got != want {
		t.Fatalf("empty path must resolve to index.html, got %q want %q", got, want)
	}
}

func TestSafeStaticPath_RejectsTraversal(t *testing.T) {
	root, _ := filepath.Abs(t.TempDir())
	for _, name := range []string{
		"../etc/passwd",
		"../../etc/passwd",
		"a/../../secret",
		"./../escape",
	} {
		t.Run(name, func(t *testing.T) {
			if got := safeStaticPath(root, name); got != "" {
				t.Fatalf("expected empty for %q, got %q", name, got)
			}
		})
	}
}

func TestSafeStaticPath_RejectsAbsolute(t *testing.T) {
	root, _ := filepath.Abs(t.TempDir())
	for _, name := range []string{
		"/etc/passwd",
		`C:\Windows\cmd.exe`,
		`\\unc\share\file`,
	} {
		t.Run(name, func(t *testing.T) {
			if got := safeStaticPath(root, name); got != "" {
				t.Fatalf("expected empty for %q, got %q", name, got)
			}
		})
	}
}

// Regression for the old PublicSPA HasPrefix bug — absDir `/tmp/store` must NOT
// accept paths that resolve under `/tmp/store-other`.
func TestSafeStaticPath_RejectsLookalikeSiblingDir(t *testing.T) {
	// Simulate the two directories.
	base := t.TempDir()
	store := filepath.Join(base, "store")
	storeOther := filepath.Join(base, "store-other")
	_ = os.MkdirAll(store, 0o755)
	_ = os.MkdirAll(storeOther, 0o755)

	// Request from inside `store` that tries to escape into `store-other`.
	got := safeStaticPath(store, "../store-other/file.txt")
	if got != "" {
		t.Fatalf("must not let store escape to store-other, got %q", got)
	}
}

// Integration: StudioSPA and DocsSite must 404 on traversal attempts rather
// than serve files outside their dir.
func TestStudioSPA_RejectsTraversal(t *testing.T) {
	tmp := t.TempDir()
	_ = os.WriteFile(filepath.Join(tmp, "index.html"), []byte("ok"), 0o644)

	r := httptest.NewRequest(http.MethodGet, "/studio/../../etc/passwd", nil)
	rec := httptest.NewRecorder()
	StudioSPA(tmp).ServeHTTP(rec, r)

	// We accept either 404 (traversal rejected) or 200 + index.html (SPA fallback
	// after rejection). What we must NOT serve is the traversal target.
	if rec.Code == http.StatusOK && string(rec.Body.Bytes()) != "ok" {
		t.Fatalf("served unexpected content: %q", rec.Body.String())
	}
}

func TestDocsSite_RejectsTraversal(t *testing.T) {
	tmp := t.TempDir()
	_ = os.WriteFile(filepath.Join(tmp, "index.html"), []byte("docs"), 0o644)

	r := httptest.NewRequest(http.MethodGet, "/docs/../../etc/passwd", nil)
	rec := httptest.NewRecorder()
	DocsSite(tmp).ServeHTTP(rec, r)

	if rec.Code == http.StatusOK && string(rec.Body.Bytes()) != "docs" {
		t.Fatalf("served unexpected content: %q", rec.Body.String())
	}
}

// Regression: a request resolving to a real SUBDIRECTORY that contains its own
// index.html must serve THAT index.html (dir-index), not fall back to the root
// index.html. Before the fix, /examples/apps/todo/ served the apex landing
// (root index.html) instead of the example app — the pgstack.org example links
// opened the marketing page.
func TestPublicSPA_ServesSubdirIndex(t *testing.T) {
	tmp := t.TempDir()
	_ = os.WriteFile(filepath.Join(tmp, "index.html"), []byte("ROOT-LANDING"), 0o644)
	sub := filepath.Join(tmp, "examples", "apps", "todo")
	_ = os.MkdirAll(sub, 0o755)
	_ = os.WriteFile(filepath.Join(sub, "index.html"), []byte("TODO-APP"), 0o644)

	for _, path := range []string{"/examples/apps/todo/", "/examples/apps/todo"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		PublicSPA(tmp).ServeHTTP(rec, r)
		if rec.Code != http.StatusOK || rec.Body.String() != "TODO-APP" {
			t.Fatalf("%s: got code=%d body=%q, want 200 + the subdir index (TODO-APP)", path, rec.Code, rec.Body.String())
		}
	}

	// A genuine client-side route (no real dir, no extension) still falls back to
	// the root index.html — SPA behaviour preserved.
	r := httptest.NewRequest(http.MethodGet, "/some/spa/route", nil)
	rec := httptest.NewRecorder()
	PublicSPA(tmp).ServeHTTP(rec, r)
	if rec.Code != http.StatusOK || rec.Body.String() != "ROOT-LANDING" {
		t.Fatalf("SPA route: got code=%d body=%q, want 200 + ROOT-LANDING", rec.Code, rec.Body.String())
	}
}
