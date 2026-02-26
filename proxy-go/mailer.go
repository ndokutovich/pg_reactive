package main

import (
	"fmt"

	"github.com/rs/zerolog/log"
	"gopkg.in/gomail.v2"
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

	if err := m.dialer.DialAndSend(msg); err != nil {
		return fmt.Errorf("SMTP send failed: %w", err)
	}

	log.Info().Str("to", to).Str("subject", subject).Msg("email sent")
	return nil
}
