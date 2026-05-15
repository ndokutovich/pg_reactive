package routes

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// StudioRedirect permanently redirects /studio → /studio/ to ensure relative
// asset paths resolve correctly in the SPA.
func StudioRedirect(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/studio/", http.StatusMovedPermanently)
}

// StudioSPA returns an http.Handler that serves the Studio SPA static files
// from dir, falling back to index.html for all unmatched paths (client-side
// routing support).
//
// If dir does not exist (e.g. studio was not built), a 404 is returned for
// all requests so the server starts successfully regardless. Path traversal
// is blocked by safeStaticPath() — see static.go.
func StudioSPA(dir string) http.Handler {
	absDir, _ := filepath.Abs(dir)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/studio/")
		fullPath := safeStaticPath(absDir, path)
		if fullPath == "" {
			http.NotFound(w, r)
			return
		}

		if _, err := os.Stat(fullPath); err != nil {
			// SPA fallback: serve index.html for any unresolved path.
			indexPath := filepath.Join(absDir, "index.html")
			if _, err2 := os.Stat(indexPath); err2 != nil {
				http.NotFound(w, r)
				return
			}
			http.ServeFile(w, r, indexPath)
			return
		}

		http.ServeFile(w, r, fullPath)
	})
}
