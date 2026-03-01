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

		// Resolve requested path relative to dir.
		urlPath := strings.TrimPrefix(r.URL.Path, "/")
		if urlPath == "" {
			urlPath = "index.html"
		}

		fullPath := filepath.Join(absDir, filepath.FromSlash(urlPath))

		// Directory traversal prevention: resolved path must stay within dir.
		cleanPath := filepath.Clean(fullPath)
		if !strings.HasPrefix(cleanPath, absDir) {
			http.NotFound(w, r)
			return
		}

		// Check if file exists.
		info, err := os.Stat(cleanPath)
		if err != nil || info.IsDir() {
			// File doesn't exist (or is a directory).
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

// setCacheHeaders sets Cache-Control based on the filename:
//   - index.html → no-cache (always revalidate)
//   - hashed assets (e.g. app.a1b2c3.js) → immutable, 1 year
//   - everything else → 1 hour
func setCacheHeaders(w http.ResponseWriter, filename string) {
	switch {
	case filename == "index.html":
		w.Header().Set("Cache-Control", "no-cache")
	case hashedAssetRe.MatchString(filename):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	default:
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}
}
