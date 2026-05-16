package routes

import "testing"

func TestValidateWebhookURL_AcceptsPublicFQDNs(t *testing.T) {
	for _, raw := range []string{
		"https://hooks.slack.com/services/T000/B000/abc",
		"https://discord.com/api/webhooks/123/xyz",
		"http://api.example.com/webhook",
		"https://my-app.example.com:8443/inbound",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := validateWebhookURL(raw); err != nil {
				t.Fatalf("expected valid, got: %v", err)
			}
		})
	}
}

func TestValidateWebhookURL_RejectsIPLiterals(t *testing.T) {
	for _, raw := range []string{
		"http://169.254.169.254/latest/meta-data/",        // AWS metadata
		"http://127.0.0.1:9200/_search",
		"http://10.0.0.5/internal",
		"https://192.168.1.1/admin",
		"http://[::1]:8080/",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := validateWebhookURL(raw); err == nil {
				t.Fatalf("expected reject for %s, got nil", raw)
			}
		})
	}
}

func TestValidateWebhookURL_RejectsInternalNames(t *testing.T) {
	for _, raw := range []string{
		"http://localhost/x",
		"http://LocalHost:9000/",
		"https://nas.local/api",
		"https://router.internal/conf",
		"http://db",         // bare docker-network name
		"http://hello-go",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := validateWebhookURL(raw); err == nil {
				t.Fatalf("expected reject for %s, got nil", raw)
			}
		})
	}
}

func TestValidateWebhookURL_RejectsBadSchemes(t *testing.T) {
	for _, raw := range []string{
		"file:///etc/passwd",
		"gopher://api.example.com/",
		"ftp://api.example.com/",
		"javascript:alert(1)",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := validateWebhookURL(raw); err == nil {
				t.Fatalf("expected reject for %s, got nil", raw)
			}
		})
	}
}

func TestValidateWebhookURL_RejectsMalformed(t *testing.T) {
	if _, err := validateWebhookURL(""); err == nil {
		t.Fatal("empty must be rejected")
	}
	if _, err := validateWebhookURL("not a url"); err == nil {
		t.Fatal("malformed must be rejected")
	}
}
