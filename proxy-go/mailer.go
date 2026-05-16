package main

import (
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
)

// Email HTML templates. Links are inserted via %s.
const (
	tmplVerification = `<p>Thanks for signing up!</p>
<p>Verify your email address by clicking the link below:</p>
<p><a href="%s">%s</a></p>
<p>This link expires in 24 hours.</p>`

	tmplPasswordReset = `<p>You requested a password reset.</p>
<p>Click the link below to set a new password:</p>
<p><a href="%s">%s</a></p>
<p>This link expires in 1 hour. If you did not request this, you can ignore this email.</p>`

	tmplMagicLink = `<p>Use the link below to sign in:</p>
<p><a href="%s">%s</a></p>
<p>This link expires in 1 hour. If you did not request this, you can ignore this email.</p>`
)

// smtpDialer is everything Mailer needs from an SMTP transport, factored out
// so tests can stub the actual network call without spinning up an SMTP
// server. Production uses smtpStdlibDialer (net/smtp + crypto/tls).
type smtpDialer interface {
	send(from, to, subject, htmlBody string) error
}

// Mailer sends transactional email via SMTP.
// When SMTP is not configured it logs the email body to the console instead
// (dev/tutorial mode).
type Mailer struct {
	from   string
	dialer smtpDialer // nil when SMTP is not configured
}

// NewMailer builds a Mailer from config. SMTP is optional; if SMTP_HOST,
// SMTP_USER, and SMTP_PASS are all set a real dialer is created. Otherwise
// emails are logged to stdout.
func NewMailer(cfg Config) *Mailer {
	m := &Mailer{from: cfg.SMTPFrom}

	if cfg.SMTPHost != "" && cfg.SMTPUser != "" && cfg.SMTPPass != "" {
		m.dialer = &smtpStdlibDialer{
			host: cfg.SMTPHost,
			port: cfg.SMTPPort,
			user: cfg.SMTPUser,
			pass: cfg.SMTPPass,
		}
		log.Info().Str("host", cfg.SMTPHost).Int("port", cfg.SMTPPort).Msg("SMTP configured")
	} else {
		log.Warn().Msg("SMTP not configured — emails will be logged to console")
	}

	return m
}

// Send delivers an HTML email to the given address.
// When SMTP is not configured the message is written to the logger instead.
func (m *Mailer) Send(to, subject, htmlBody string) error {
	if m.dialer == nil {
		preview := htmlBody
		if len(preview) > 200 {
			preview = preview[:200]
		}
		log.Info().
			Str("to", to).
			Str("subject", subject).
			Msgf("EMAIL (dev mode — configure SMTP to send for real)\n  Body: %s", preview)
		return nil
	}

	if err := m.sendWithRetry(to, subject, htmlBody); err != nil {
		return fmt.Errorf("SMTP send failed: %w", err)
	}

	log.Info().Str("to", to).Str("subject", subject).Msg("email sent")
	return nil
}

// sendWithRetry attempts delivery up to 3 times with exponential backoff
// (1s, 2s) to handle transient SMTP errors.
func (m *Mailer) sendWithRetry(to, subject, htmlBody string) error {
	var lastErr error
	for attempt := range 3 {
		if lastErr = m.dialer.send(m.from, to, subject, htmlBody); lastErr == nil {
			return nil
		}
		if attempt < 2 {
			time.Sleep(time.Duration(1<<attempt) * time.Second)
		}
	}
	return lastErr
}

// SendEmailVerification sends a verification link to a newly registered user.
func (m *Mailer) SendEmailVerification(to, verifyURL string) error {
	body := fmt.Sprintf(tmplVerification, verifyURL, verifyURL)
	return m.Send(to, "Verify your email", body)
}

// SendPasswordReset sends a password-reset link.
func (m *Mailer) SendPasswordReset(to, resetURL string) error {
	body := fmt.Sprintf(tmplPasswordReset, resetURL, resetURL)
	return m.Send(to, "Reset your password", body)
}

// SendMagicLink sends a one-time sign-in link.
func (m *Mailer) SendMagicLink(to, linkURL string) error {
	body := fmt.Sprintf(tmplMagicLink, linkURL, linkURL)
	return m.Send(to, "Your sign-in link", body)
}

// smtpStdlibDialer implements smtpDialer using crypto/tls + net/smtp from
// the standard library. The implementation handles three common SMTP
// transports without external dependencies:
//
//   - Port 465: implicit TLS (TLS handshake before SMTP banner).
//   - Port 587: STARTTLS (plain banner, then upgrade).
//   - Other ports: plain SMTP (only sensible inside a private network).
//
// Auth uses smtp.PlainAuth — sufficient for SendGrid, Mailgun, SES, and
// most modern transactional providers. Mailers that require XOAUTH2 or
// other modern mechanisms need a richer library.
type smtpStdlibDialer struct {
	host string
	port int
	user string
	pass string
}

func (d *smtpStdlibDialer) send(from, to, subject, htmlBody string) error {
	addr := net.JoinHostPort(d.host, strconv.Itoa(d.port))
	tlsConfig := &tls.Config{ServerName: d.host, MinVersion: tls.VersionTLS12}

	var (
		conn net.Conn
		err  error
	)
	if d.port == 465 {
		// Implicit TLS — handshake before SMTP greeting.
		conn, err = tls.Dial("tcp", addr, tlsConfig)
	} else {
		conn, err = net.DialTimeout("tcp", addr, 30*time.Second)
	}
	if err != nil {
		return fmt.Errorf("smtp dial %s: %w", addr, err)
	}
	defer conn.Close()

	c, err := smtp.NewClient(conn, d.host)
	if err != nil {
		return fmt.Errorf("smtp client: %w", err)
	}
	defer c.Close()

	if d.port != 465 {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(tlsConfig); err != nil {
				return fmt.Errorf("smtp starttls: %w", err)
			}
		}
	}

	if ok, _ := c.Extension("AUTH"); ok {
		auth := smtp.PlainAuth("", d.user, d.pass, d.host)
		if err := c.Auth(auth); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}

	if err := c.Mail(from); err != nil {
		return fmt.Errorf("smtp MAIL FROM: %w", err)
	}
	if err := c.Rcpt(to); err != nil {
		return fmt.Errorf("smtp RCPT TO: %w", err)
	}

	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp DATA: %w", err)
	}
	if _, err := w.Write([]byte(buildMessage(from, to, subject, htmlBody))); err != nil {
		w.Close()
		return fmt.Errorf("smtp body: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp body close: %w", err)
	}

	return c.Quit()
}

// buildMessage constructs an RFC 5322 message with a single text/html body.
// Subject is RFC 2047 encoded only when it contains non-ASCII characters —
// most templated subjects ("Verify your email", "Reset your password") are
// pure ASCII and pass through unchanged.
func buildMessage(from, to, subject, htmlBody string) string {
	var b strings.Builder
	b.Grow(len(htmlBody) + 256)
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", to)
	fmt.Fprintf(&b, "Subject: %s\r\n", encodeHeader(subject))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/html; charset=utf-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	b.WriteString("\r\n")
	b.WriteString(htmlBody)
	return b.String()
}

// encodeHeader wraps a header value in RFC 2047 B-encoding when it contains
// non-ASCII bytes. ASCII passes through unchanged so dev/test inspection
// stays human-readable.
func encodeHeader(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] > 127 {
			return "=?utf-8?B?" + base64.StdEncoding.EncodeToString([]byte(s)) + "?="
		}
	}
	return s
}
