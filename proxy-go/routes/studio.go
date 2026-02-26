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
// all requests so the server starts successfully regardless.
func StudioSPA(dir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Strip the /studio/ prefix so the file server resolves from dir root.
		path := strings.TrimPrefix(r.URL.Path, "/studio/")
		if path == "" {
			path = "index.html"
		}

		fullPath := filepath.Join(dir, filepath.FromSlash(path))

		// Check if the file exists; if not, fall back to index.html for SPA routing.
		if _, err := os.Stat(fullPath); err != nil {
			// Serve index.html for SPA client-side routes.
			indexPath := filepath.Join(dir, "index.html")
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
