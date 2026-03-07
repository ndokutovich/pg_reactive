package main

import (
	"fmt"
	"time"

	"github.com/rs/zerolog/log"
	"gopkg.in/gomail.v2"
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

// Mailer sends transactional email via SMTP.
// When SMTP is not configured it logs the email body to the console instead
// (dev/tutorial mode).
type Mailer struct {
	from   string
	dialer *gomail.Dialer // nil when SMTP is not configured
}

// NewMailer builds a Mailer from config. SMTP is optional; if SMTP_HOST,
// SMTP_USER, and SMTP_PASS are all set a real dialer is created. Otherwise
// emails are logged to stdout.
func NewMailer(cfg Config) *Mailer {
	m := &Mailer{from: cfg.SMTPFrom}

	if cfg.SMTPHost != "" && cfg.SMTPUser != "" && cfg.SMTPPass != "" {
		d := gomail.NewDialer(cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPUser, cfg.SMTPPass)
		m.dialer = d
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

	msg := gomail.NewMessage()
	msg.SetHeader("From", m.from)
	msg.SetHeader("To", to)
	msg.SetHeader("Subject", subject)
	msg.SetBody("text/html", htmlBody)

	if err := m.sendWithRetry(msg); err != nil {
		return fmt.Errorf("SMTP send failed: %w", err)
	}

	log.Info().Str("to", to).Str("subject", subject).Msg("email sent")
	return nil
}

// sendWithRetry attempts delivery up to 3 times with exponential backoff
// (1s, 2s) to handle transient SMTP errors.
func (m *Mailer) sendWithRetry(msg *gomail.Message) error {
	var lastErr error
	for attempt := range 3 {
		if lastErr = m.dialer.DialAndSend(msg); lastErr == nil {
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
