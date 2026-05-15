package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// testApplePrivateKeyPEM generates a fresh P-256 key as PKCS#8 PEM — the same
// shape as the contents of an Apple .p8 file.
func testApplePrivateKeyPEM(t *testing.T) (string, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("marshal pkcs8: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), key
}

func TestGenerateAppleClientSecret_SignsValidES256JWT(t *testing.T) {
	resetAppleSecretCache()
	pemKey, key := testApplePrivateKeyPEM(t)
	d := &Deps{
		AppleClientID:   "com.example.auth",
		AppleTeamID:     "ABCDE12345",
		AppleKeyID:      "FGHIJ67890",
		ApplePrivateKey: pemKey,
	}

	secret := generateAppleClientSecret(d)
	if secret == "" {
		t.Fatal("generateAppleClientSecret returned empty string")
	}

	tok, err := jwt.Parse(secret, func(tok *jwt.Token) (any, error) {
		if _, ok := tok.Method.(*jwt.SigningMethodECDSA); !ok {
			t.Fatalf("expected ECDSA signing method, got %T", tok.Method)
		}
		return &key.PublicKey, nil
	})
	if err != nil {
		t.Fatalf("generated client_secret failed verification: %v", err)
	}
	if !tok.Valid {
		t.Fatal("generated client_secret is not valid")
	}
	if kid, _ := tok.Header["kid"].(string); kid != "FGHIJ67890" {
		t.Errorf("header kid = %q, want FGHIJ67890", kid)
	}

	claims := tok.Claims.(jwt.MapClaims)
	if claims["iss"] != "ABCDE12345" {
		t.Errorf("iss = %v, want ABCDE12345", claims["iss"])
	}
	if claims["sub"] != "com.example.auth" {
		t.Errorf("sub = %v, want com.example.auth", claims["sub"])
	}
	if claims["aud"] != "https://appleid.apple.com" {
		t.Errorf("aud = %v, want https://appleid.apple.com", claims["aud"])
	}
}

func TestGenerateAppleClientSecret_CachesUntilNearExpiry(t *testing.T) {
	resetAppleSecretCache()
	pemKey, _ := testApplePrivateKeyPEM(t)
	d := &Deps{AppleClientID: "c", AppleTeamID: "t", AppleKeyID: "k", ApplePrivateKey: pemKey}

	first := generateAppleClientSecret(d)
	second := generateAppleClientSecret(d)
	if first != second {
		t.Error("expected cached client_secret to be reused on the second call")
	}
}

func TestGenerateAppleClientSecret_PassesThroughPreGeneratedJWT(t *testing.T) {
	resetAppleSecretCache()
	// A pre-generated compact JWT (three dot-separated segments, no PEM armour)
	// must be returned verbatim for back-compat.
	preGen := "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ0In0.c2lnbmF0dXJl"
	d := &Deps{ApplePrivateKey: preGen}
	if got := generateAppleClientSecret(d); got != preGen {
		t.Errorf("pre-generated JWT not passed through: got %q", got)
	}
}

func TestGenerateAppleClientSecret_EmptyOnBadKey(t *testing.T) {
	resetAppleSecretCache()
	d := &Deps{ApplePrivateKey: "-----BEGIN PRIVATE KEY-----\nnot-base64\n-----END PRIVATE KEY-----"}
	if got := generateAppleClientSecret(d); got != "" {
		t.Errorf("expected empty string on unparseable key, got %q", got)
	}

	resetAppleSecretCache()
	d = &Deps{ApplePrivateKey: ""}
	if got := generateAppleClientSecret(d); got != "" {
		t.Errorf("expected empty string on missing key, got %q", got)
	}
}

func TestLooksLikeJWT(t *testing.T) {
	cases := map[string]bool{
		"a.b.c": true,
		"eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ0In0.sig":        true,
		"-----BEGIN PRIVATE KEY-----\na.b.c\n-----END---": false,
		"a.b":         false,
		"a.b.c.d":     false,
		"plainstring": false,
		"  a.b.c  ":   true,
	}
	for in, want := range cases {
		if got := looksLikeJWT(in); got != want {
			t.Errorf("looksLikeJWT(%q) = %v, want %v", in, got, want)
		}
	}
}

// resetAppleSecretCache clears the package-level memo so each test starts clean.
func resetAppleSecretCache() {
	appleSecretMu.Lock()
	appleSecretValue = ""
	appleSecretExpires = time.Time{}
	appleSecretMu.Unlock()
}
