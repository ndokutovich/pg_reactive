package realtime

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"syscall"
	"time"
)

// newWebhookHTTPClient builds the http.Client used for outbound webhook
// delivery. Three layers of SSRF defence on top of the URL allowlist
// already enforced at create/refresh time (validateWebhookURL):
//
//  1. CheckRedirect refuses ALL redirects. A 30x reply to a webhook
//     POST is suspicious — legitimate ingest endpoints don't redirect.
//     Following them would let a public webhook target 302 us to
//     http://169.254.169.254/ (AWS metadata) or an internal node.
//  2. Custom Dialer.Control runs once per resolved address right
//     before the TCP connect. We drop the connection if the resolved
//     IP falls in any private / loopback / link-local / multicast /
//     unspecified range. This closes the DNS-rebinding window where
//     `evil.com` resolved to a public IP at validate-time and to
//     127.0.0.1 at delivery time.
//  3. 10 s overall request timeout — sloth gates.
//
// (Audit follow-up to F1, 5th-pass review 2026-05.)
func newWebhookHTTPClient() *http.Client {
	dialer := &net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
		Control: func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return fmt.Errorf("webhook dial: split host: %w", err)
			}
			ip := net.ParseIP(host)
			if ip == nil {
				return fmt.Errorf("webhook dial: address %q is not an IP", address)
			}
			if !isPublicUnicast(ip) {
				return fmt.Errorf("webhook dial: refusing connection to non-public IP %s", ip)
			}
			return nil
		},
	}
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			DialContext:           dialer.DialContext,
			MaxIdleConns:          20,
			IdleConnTimeout:       60 * time.Second,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: 5 * time.Second,
		},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errRedirectsBlocked
		},
	}
}

// errRedirectsBlocked is returned by CheckRedirect to abort a webhook
// delivery that would otherwise follow a 30x to a different host. Net/http
// will surface this as an error from client.Do; deliverWithRetry treats
// it as a permanent failure (no retry — the response intent itself is
// adversarial).
var errRedirectsBlocked = errors.New("webhook delivery: redirects are not followed")

// isPublicUnicast returns true when ip is a routable, public unicast
// address. Everything else (loopback, private RFC1918, link-local /
// metadata-server, multicast, unspecified, broadcast) is refused.
func isPublicUnicast(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() {
		return false
	}
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false // 169.254.0.0/16 covers the cloud metadata endpoint
	}
	if ip.IsPrivate() {
		return false // RFC 1918 + RFC 6598 + IPv6 ULA
	}
	if v4 := ip.To4(); v4 != nil {
		// Defensive: refuse 0.0.0.0/8 and 255.255.255.255 just in case.
		if v4[0] == 0 || v4.Equal(net.IPv4bcast) {
			return false
		}
		// RFC 6598 — carrier-grade NAT (100.64.0.0/10). Go's IsPrivate
		// doesn't cover this; it's still effectively private space.
		if v4[0] == 100 && v4[1]&0xC0 == 64 {
			return false
		}
		// IANA special-purpose ranges. Public-only policy refuses each.
		for _, r := range ipv4Reserved {
			if r.Contains(v4) {
				return false
			}
		}
	} else if ip.To16() != nil {
		for _, r := range ipv6Reserved {
			if r.Contains(ip) {
				return false
			}
		}
	}
	return true
}

// ipv4Reserved / ipv6Reserved are IANA special-purpose ranges that we
// refuse to dial as webhook targets — on top of loopback/private/link-
// local already covered by stdlib checks. (Audit 6th pass, 2026-05.)
var (
	ipv4Reserved = mustParseCIDRs(
		"192.0.0.0/24",     // IETF protocol assignments
		"192.0.2.0/24",     // TEST-NET-1 (RFC 5737 documentation)
		"198.51.100.0/24",  // TEST-NET-2
		"203.0.113.0/24",   // TEST-NET-3
		"198.18.0.0/15",    // benchmark testing (RFC 2544)
		"240.0.0.0/4",      // reserved (former class E)
		"192.88.99.0/24",   // deprecated 6to4 anycast (RFC 7526)
	)
	ipv6Reserved = mustParseCIDRs(
		"2001:db8::/32",    // documentation (RFC 3849)
		"100::/64",         // discard-only prefix (RFC 6666)
		"2001::/23",        // IETF protocol assignments (includes ORCHID, TEREDO, etc.)
	)
)

func mustParseCIDRs(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, s := range cidrs {
		_, n, err := net.ParseCIDR(s)
		if err != nil {
			panic("webhook policy: invalid CIDR " + s + ": " + err.Error())
		}
		out = append(out, n)
	}
	return out
}

// Context-aware helper for tests that need to verify the dialer policy
// without binding a real socket. The exported wrapper keeps the policy
// in lockstep with what newWebhookHTTPClient actually applies.
func webhookDialerWouldAllow(ctx context.Context, host string) error {
	ip := net.ParseIP(host)
	if ip == nil {
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return err
		}
		for _, a := range ips {
			if !isPublicUnicast(a.IP) {
				return fmt.Errorf("host %q resolved to non-public IP %s", host, a.IP)
			}
		}
		return nil
	}
	if !isPublicUnicast(ip) {
		return fmt.Errorf("ip %s is not public unicast", ip)
	}
	return nil
}
