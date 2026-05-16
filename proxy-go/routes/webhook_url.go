package routes

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// validateWebhookURL enforces an SSRF-resistant policy on webhook target
// URLs (audit finding F5, 2026-05).
//
// Webhooks DO target external public endpoints (Slack, Discord, customer
// apps) — unlike polyglot edge functions which talk to sibling containers.
// So we cannot use the strict "bare hostname only" rule from
// functions/http.go. Instead:
//
//   * http or https scheme only — no file://, gopher://, etc.
//   * Host must parse.
//   * Reject IP literals entirely. This blocks the cloud metadata server
//     (169.254.169.254), VPN gateways, internal-only nodes, and loopback
//     in one rule. If you really need to deliver to an IP, put a DNS name
//     in front.
//   * Reject obviously-internal hostnames: localhost, *.local, *.internal,
//     and bare names with no dots (docker-network hosts).
//
// What we DO NOT do at create time: DNS-resolve and walk the address
// list. That race-windows with DNS rebinding and won't catch hostnames
// that resolve to private ranges later. A delivery-time hardening pass
// is a worthwhile follow-up.
func validateWebhookURL(raw string) (*url.URL, error) {
	if raw == "" {
		return nil, fmt.Errorf("url is empty")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid url: %w", err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return nil, fmt.Errorf("url scheme must be http or https, got %q", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return nil, fmt.Errorf("url has no host")
	}

	// IP literals — block outright; the user can put a DNS name in front.
	if ip := net.ParseIP(host); ip != nil {
		return nil, fmt.Errorf("url host must be a hostname, not an IP literal (%s)", host)
	}

	// Reject internal-network conventions.
	lower := strings.ToLower(host)
	if lower == "localhost" {
		return nil, fmt.Errorf("url host %q is loopback", host)
	}
	if strings.HasSuffix(lower, ".local") || strings.HasSuffix(lower, ".internal") {
		return nil, fmt.Errorf("url host %q targets an internal-only TLD", host)
	}
	// Bare names without a dot are docker-network sibling hostnames (e.g.
	// "hello-go"). External webhook targets always have a public FQDN.
	if !strings.Contains(host, ".") {
		return nil, fmt.Errorf("url host %q is not a public FQDN (bare name routes to internal services)", host)
	}

	return u, nil
}
