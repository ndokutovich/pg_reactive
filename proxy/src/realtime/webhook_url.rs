//! SSRF / DNS-rebinding guard for outbound webhook delivery.
//!
//! Port of the Go reference `proxy-go/realtime/webhook_url.go`
//! (`ValidateWebhookURL`) and the delivery-time IP policy from
//! `proxy-go/realtime/webhook_client.go` (`isPublicUnicast`). The two MUST stay
//! byte-for-byte identical in policy with Go — under-blocking is a security
//! regression (SECURITY.md trust matrix "Webhook CRUD" row + the
//! "webhook delivery (SSRF)" capability; audit findings F5 create-time and
//! F1/5th-6th-pass delivery-time).
//!
//! Two layers, exactly as Go:
//!
//!  1. [`validate_webhook_url`] — create/refresh-time policy on the URL string:
//!     http|https only, host must parse, IP literals rejected outright,
//!     loopback / `.local` / `.internal` / bare (dot-less) hostnames rejected.
//!  2. [`is_public_unicast`] — delivery-time policy on the *resolved* IP, used
//!     by the hardened reqwest client to close the DNS-rebinding window where a
//!     name resolved to a public IP at validate-time and to 127.0.0.1 / a
//!     private node at delivery-time.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use ipnet::{Ipv4Net, Ipv6Net};
use url::Url;

/// Enforce the SSRF-resistant policy on a webhook target URL string. Returns the
/// parsed [`Url`] on success.
///
/// Mirrors Go `ValidateWebhookURL`:
///   * http or https scheme only.
///   * Host must parse.
///   * IP literals rejected outright (blocks 169.254.169.254 metadata, loopback,
///     VPN gateways, internal nodes in one rule — put a DNS name in front).
///   * `localhost`, `*.local`, `*.internal`, and bare dot-less names rejected.
pub fn validate_webhook_url(raw: &str) -> Result<Url, String> {
    if raw.is_empty() {
        return Err("url is empty".into());
    }
    let u = Url::parse(raw).map_err(|e| format!("invalid url: {e}"))?;

    let scheme = u.scheme().to_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!("url scheme must be http or https, got {:?}", u.scheme()));
    }

    let host = match u.host_str() {
        Some(h) if !h.is_empty() => h,
        _ => return Err("url has no host".into()),
    };

    // IP literals — block outright; the user can put a DNS name in front. The
    // `url` crate strips the brackets from `[::1]`, so a bare `IpAddr::parse`
    // catches both v4 and v6 literals.
    if host.parse::<IpAddr>().is_ok() {
        return Err(format!(
            "url host must be a hostname, not an IP literal ({host})"
        ));
    }
    // url::Host also classifies IPv6 literals; reject those too (defensive — the
    // string parse above already covers `[::1]` once brackets are stripped).
    if matches!(u.host(), Some(url::Host::Ipv6(_)) | Some(url::Host::Ipv4(_))) {
        return Err(format!(
            "url host must be a hostname, not an IP literal ({host})"
        ));
    }

    let lower = host.to_lowercase();
    if lower == "localhost" {
        return Err(format!("url host {host:?} is loopback"));
    }
    if lower.ends_with(".local") || lower.ends_with(".internal") {
        return Err(format!("url host {host:?} targets an internal-only TLD"));
    }
    // Bare names without a dot are docker-network sibling hostnames (e.g.
    // "hello-go"). External webhook targets always have a public FQDN.
    if !host.contains('.') {
        return Err(format!(
            "url host {host:?} is not a public FQDN (bare name routes to internal services)"
        ));
    }

    Ok(u)
}

/// Returns true when `ip` is a routable, public unicast address. Everything else
/// (loopback, private RFC1918/RFC6598, link-local / metadata-server, multicast,
/// unspecified, broadcast, IANA special-purpose) is refused.
///
/// Byte-for-byte mirror of Go `isPublicUnicast` (webhook_client.go).
pub fn is_public_unicast(ip: IpAddr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        return false;
    }
    match ip {
        IpAddr::V4(v4) => is_public_unicast_v4(v4),
        IpAddr::V6(v6) => is_public_unicast_v6(v6),
    }
}

fn is_public_unicast_v4(v4: Ipv4Addr) -> bool {
    // Link-local 169.254.0.0/16 — covers the cloud metadata endpoint.
    if v4.is_link_local() {
        return false;
    }
    // RFC 1918 private space (10/8, 172.16/12, 192.168/16).
    if v4.is_private() {
        return false;
    }
    // Defensive: 0.0.0.0/8 and 255.255.255.255.
    let o = v4.octets();
    if o[0] == 0 || v4.is_broadcast() {
        return false;
    }
    // RFC 6598 — carrier-grade NAT (100.64.0.0/10). std's is_private doesn't
    // cover this; it is still effectively private space.
    if o[0] == 100 && (o[1] & 0xC0) == 64 {
        return false;
    }
    // IANA special-purpose ranges. Public-only policy refuses each.
    for r in ipv4_reserved() {
        if r.contains(&v4) {
            return false;
        }
    }
    true
}

fn is_public_unicast_v6(v6: Ipv6Addr) -> bool {
    // Link-local fe80::/10 (unicast) and link-local multicast (already covered
    // by is_multicast above). std's is_unicast_link_local is unstable, so test
    // the prefix directly.
    let seg0 = v6.segments()[0];
    if (seg0 & 0xffc0) == 0xfe80 {
        return false;
    }
    // Unique local addresses fc00::/7 (IPv6 ULA — the v6 analogue of RFC1918).
    if (v6.octets()[0] & 0xfe) == 0xfc {
        return false;
    }
    for r in ipv6_reserved() {
        if r.contains(&v6) {
            return false;
        }
    }
    true
}

/// IANA special-purpose IPv4 ranges refused as webhook targets, on top of
/// loopback/private/link-local already covered above (Go `ipv4Reserved`).
fn ipv4_reserved() -> [Ipv4Net; 7] {
    [
        "192.0.0.0/24".parse().unwrap(),    // IETF protocol assignments
        "192.0.2.0/24".parse().unwrap(),    // TEST-NET-1 (RFC 5737)
        "198.51.100.0/24".parse().unwrap(), // TEST-NET-2
        "203.0.113.0/24".parse().unwrap(),  // TEST-NET-3
        "198.18.0.0/15".parse().unwrap(),   // benchmark testing (RFC 2544)
        "240.0.0.0/4".parse().unwrap(),     // reserved (former class E)
        "192.88.99.0/24".parse().unwrap(),  // deprecated 6to4 anycast (RFC 7526)
    ]
}

/// IANA special-purpose IPv6 ranges (Go `ipv6Reserved`).
fn ipv6_reserved() -> [Ipv6Net; 3] {
    [
        "2001:db8::/32".parse().unwrap(), // documentation (RFC 3849)
        "100::/64".parse().unwrap(),      // discard-only prefix (RFC 6666)
        "2001::/23".parse().unwrap(),     // IETF protocol assignments
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_public_fqdns() {
        for raw in [
            "https://hooks.slack.com/services/T000/B000/abc",
            "https://discord.com/api/webhooks/123/xyz",
            "http://api.example.com/webhook",
            "https://my-app.example.com:8443/inbound",
        ] {
            assert!(
                validate_webhook_url(raw).is_ok(),
                "expected valid: {raw}"
            );
        }
    }

    #[test]
    fn rejects_ip_literals() {
        for raw in [
            "http://169.254.169.254/latest/meta-data/", // AWS metadata
            "http://127.0.0.1:9200/_search",
            "http://10.0.0.5/internal",
            "https://192.168.1.1/admin",
            "http://[::1]:8080/",
        ] {
            assert!(
                validate_webhook_url(raw).is_err(),
                "expected reject: {raw}"
            );
        }
    }

    #[test]
    fn rejects_internal_names() {
        for raw in [
            "http://localhost/x",
            "http://LocalHost:9000/",
            "https://nas.local/api",
            "https://router.internal/conf",
            "http://db",       // bare docker-network name
            "http://hello-go", // bare docker-network name
        ] {
            assert!(
                validate_webhook_url(raw).is_err(),
                "expected reject: {raw}"
            );
        }
    }

    #[test]
    fn rejects_bad_schemes() {
        for raw in [
            "file:///etc/passwd",
            "gopher://api.example.com/",
            "ftp://api.example.com/",
            "javascript:alert(1)",
        ] {
            assert!(
                validate_webhook_url(raw).is_err(),
                "expected reject: {raw}"
            );
        }
    }

    #[test]
    fn rejects_malformed() {
        assert!(validate_webhook_url("").is_err());
        assert!(validate_webhook_url("not a url").is_err());
    }

    // Delivery-time IP policy parity with Go isPublicUnicast — the DNS-rebinding
    // defense. A hostname that resolves to any of these is dropped at dial time.
    #[test]
    fn is_public_unicast_rejects_private_and_special() {
        let reject = [
            "127.0.0.1",         // loopback
            "::1",               // loopback v6
            "169.254.169.254",   // link-local / cloud metadata
            "10.0.0.5",          // RFC1918
            "192.168.1.1",       // RFC1918
            "172.16.5.4",        // RFC1918
            "100.64.0.1",        // RFC6598 CGNAT
            "0.0.0.0",           // unspecified
            "255.255.255.255",   // broadcast
            "224.0.0.1",         // multicast
            "240.0.0.1",         // reserved class E
            "198.18.0.1",        // benchmark
            "192.0.2.1",         // TEST-NET-1
            "fe80::1",           // link-local v6
            "fc00::1",           // ULA v6
            "fd12:3456:789a::1", // ULA v6
            "2001:db8::1",       // documentation v6
        ];
        for s in reject {
            let ip: IpAddr = s.parse().unwrap();
            assert!(!is_public_unicast(ip), "{s} must be refused");
        }
    }

    #[test]
    fn is_public_unicast_allows_public() {
        let allow = [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.216.34", // example.com
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ];
        for s in allow {
            let ip: IpAddr = s.parse().unwrap();
            assert!(is_public_unicast(ip), "{s} must be allowed");
        }
    }
}
