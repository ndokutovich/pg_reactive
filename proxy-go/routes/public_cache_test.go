package routes

import (
	"net/http/httptest"
	"testing"
)

// The public SPA cache policy has three tiers. The middle one exists for
// no-bundler apps: js/style.css served by their real names must revalidate
// on every load or a deploy takes up to the old 1h TTL to reach players.
func TestSetCacheHeaders(t *testing.T) {
	const (
		immutable  = "public, max-age=31536000, immutable"
		revalidate = "no-cache"
		hour       = "public, max-age=3600"
	)
	cases := []struct {
		filename string
		want     string
	}{
		// entry documents
		{"index.html", revalidate},
		{"404.html", revalidate},
		// unhashed code — no-bundler apps
		{"Game.js", revalidate},
		{"style.css", revalidate},
		{"client.mjs", revalidate},
		{"STYLE.CSS", revalidate},
		// hashed bundler output wins over the extension rule
		{"app.a1b2c3d4.js", immutable},
		{"chunk.0f1e2d3c4b.css", immutable},
		{"index.deadbeef.html", immutable},
		// everything else keeps the 1h default
		{"logo-32.png", hour},
		{"game-intro.mp3", hour},
		{"manifest.json", hour},
		{"physics.wasm", hour},
		{"noext", hour},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		setCacheHeaders(rec, c.filename)
		if got := rec.Header().Get("Cache-Control"); got != c.want {
			t.Errorf("%s: Cache-Control = %q, want %q", c.filename, got, c.want)
		}
	}
}
