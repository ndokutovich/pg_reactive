package routes

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// hashedAssetRe matches filenames like "app.a1b2c3d4.js" or "styles.EHI6WK3Q.css"
// where the penultimate segment (between dots) is ≥6 hex chars.
var hashedAssetRe = regexp.MustCompile(`\.[0-9a-fA-F]{6,}\.`)

// PublicSPA returns an http.Handler that serves user static files from dir,
// falling back to index.html for paths without a file extension (SPA routing).
//
// Design:
//   - Only GET/HEAD methods are served (others → 404)
//   - Directory traversal is prevented via filepath.Clean prefix check
//   - Caching: no-cache for index.html, immutable for hashed assets, 1h otherwise
//   - Paths with file extensions that don't exist → 404 (not SPA fallback)
//   - Paths without file extensions that don't exist → index.html (SPA fallback)
func PublicSPA(dir string) http.Handler {
	absDir, _ := filepath.Abs(dir)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only serve GET and HEAD.
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}

		// Resolve requested path. safeStaticPath enforces the traversal guard
		// using filepath.Rel rather than HasPrefix (HasPrefix can falsely accept
		// e.g. /tmp/store-other when absDir is /tmp/store).
		urlPath := strings.TrimPrefix(r.URL.Path, "/")
		cleanPath := safeStaticPath(absDir, urlPath)
		if cleanPath == "" {
			http.NotFound(w, r)
			return
		}
		if urlPath == "" {
			urlPath = "index.html"
		}

		// Check if file exists.
		info, err := os.Stat(cleanPath)
		if err == nil && info.IsDir() {
			// A real directory under the public root → serve its OWN index.html
			// (dir-index) when present, before any root SPA fallback. Without
			// this, /examples/apps/todo/ served the apex landing instead of the
			// example. r.URL.Path keeps the directory form, so http.ServeFile
			// does not redirect (it only redirects paths ending in /index.html).
			dirIndex := filepath.Join(cleanPath, "index.html")
			if di, e := os.Stat(dirIndex); e == nil && !di.IsDir() {
				setCacheHeaders(w, "index.html")
				http.ServeFile(w, r, dirIndex)
				return
			}
		}
		if err != nil || info.IsDir() {
			// File doesn't exist (or is a directory without its own index.html).
			// If the path has a file extension, it's a missing asset → 404.
			if filepath.Ext(urlPath) != "" {
				http.NotFound(w, r)
				return
			}
			// No extension → SPA client-side route → serve index.html.
			indexPath := filepath.Join(absDir, "index.html")
			if _, err2 := os.Stat(indexPath); err2 != nil {
				http.NotFound(w, r)
				return
			}
			setCacheHeaders(w, "index.html")
			http.ServeFile(w, r, indexPath)
			return
		}

		setCacheHeaders(w, filepath.Base(cleanPath))
		http.ServeFile(w, r, cleanPath)
	})
}

// revalidateExt lists extensions that are served by their real names in
// no-bundler apps (index.html + <script src="js/game.js">). Without a
// content hash in the filename a deploy can only reach the browser through
// revalidation, so these get no-cache: the browser keeps its copy and asks
// (cheap 304 via Last-Modified) on every load. Hashed filenames are checked
// FIRST in setCacheHeaders, so bundler output still gets the immutable path.
var revalidateExt = map[string]bool{
	".html": true,
	".js":   true,
	".mjs":  true,
	".css":  true,
}

// setCacheHeaders sets Cache-Control based on the filename:
//   - hashed assets (e.g. app.a1b2c3.js) → immutable, 1 year
//   - .html / unhashed .js .mjs .css → no-cache (always revalidate)
//   - everything else (images, audio, fonts, wasm, json) → 1 hour
func setCacheHeaders(w http.ResponseWriter, filename string) {
	switch {
	case hashedAssetRe.MatchString(filename):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	case revalidateExt[strings.ToLower(filepath.Ext(filename))]:
		w.Header().Set("Cache-Control", "no-cache")
	default:
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}
}
