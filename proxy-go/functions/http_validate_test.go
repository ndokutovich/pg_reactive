package functions

import "testing"

// Audit round 28 F3 regression tests. validateUpstreamURL must accept
// docker-network bare hostnames and reject anything that points at
// loopback or arbitrary public hosts. Previous versions blocked IP
// literals and dotted names but let "localhost" through.

func TestValidateUpstreamURL_AcceptsDockerHostname(t *testing.T) {
	cases := []string{
		"http://my-fn:8080",
		"http://my-fn:8080/v1/handler",
		"https://upstream-service",
	}
	for _, c := range cases {
		if _, err := validateUpstreamURL(c); err != nil {
			t.Errorf("validateUpstreamURL(%q) returned %v, want nil", c, err)
		}
	}
}

func TestValidateUpstreamURL_RejectsLoopbackBareNames(t *testing.T) {
	cases := []string{
		"http://localhost",
		"http://localhost:8080",
		"https://LocalHost:9000/api",
		"http://localhost.localdomain:8080",
		"http://ip6-localhost",
		"http://ip6-loopback",
	}
	for _, c := range cases {
		if _, err := validateUpstreamURL(c); err == nil {
			t.Errorf("validateUpstreamURL(%q) accepted loopback bare hostname — must reject", c)
		}
	}
}

func TestValidateUpstreamURL_RejectsIPLiterals(t *testing.T) {
	cases := []string{
		"http://127.0.0.1:8080",
		"http://0.0.0.0:8080",
		"http://169.254.169.254", // EC2/GCE metadata
		"http://[::1]:8080",
	}
	for _, c := range cases {
		if _, err := validateUpstreamURL(c); err == nil {
			t.Errorf("validateUpstreamURL(%q) accepted IP literal — must reject", c)
		}
	}
}

func TestValidateUpstreamURL_RejectsDottedFQDN(t *testing.T) {
	cases := []string{
		"http://attacker.example.com",
		"https://api.internal.corp",
	}
	for _, c := range cases {
		if _, err := validateUpstreamURL(c); err == nil {
			t.Errorf("validateUpstreamURL(%q) accepted dotted FQDN — must reject", c)
		}
	}
}

func TestValidateUpstreamURL_RejectsNonHTTPSchemes(t *testing.T) {
	cases := []string{
		"file:///etc/passwd",
		"gopher://x:70/",
		"ftp://x",
	}
	for _, c := range cases {
		if _, err := validateUpstreamURL(c); err == nil {
			t.Errorf("validateUpstreamURL(%q) accepted non-http scheme — must reject", c)
		}
	}
}

func TestValidateUpstreamURL_RejectsEmpty(t *testing.T) {
	if _, err := validateUpstreamURL(""); err == nil {
		t.Error("validateUpstreamURL(\"\") accepted empty URL — must reject")
	}
}
