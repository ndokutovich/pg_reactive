// hello-go — reference polyglot edge function for the pgstack `http` runtime.
//
// The proxy is written in Go, but THIS is a separate process and image with
// zero shared code — it proves the edge-function boundary is HTTP, not an
// in-process runtime. The exact same contract works from Rust, Python, Bun,
// or anything else that can serve HTTP.
//
// Contract:
//   - the pgstack proxy forwards POST /functions/v1/{name} here;
//   - it injects the caller's identity as X-Pgstack-Role / X-Pgstack-Sub /
//     X-Pgstack-Claims headers (it validated the JWT/anon key and stripped
//     any inbound spoofed copies — trust these headers);
//   - GET /healthz is for the container healthcheck.
package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const maxBody = 1 << 20 // 1 MiB

func main() {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":9100"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("POST /functions/v1/{name}", handle)

	srv := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	go func() {
		log.Printf("hello-go edge function listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
}

func handle(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(io.LimitReader(r.Body, maxBody))

	var received any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &received); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message":  "hello from a Go edge function",
		"function": r.PathValue("name"),
		// Identity comes from the proxy-injected headers — see the file header.
		"role":     r.Header.Get("X-Pgstack-Role"),
		"sub":      r.Header.Get("X-Pgstack-Sub"),
		"received": received,
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
