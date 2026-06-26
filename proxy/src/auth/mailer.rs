use lettre::{
    message::header::ContentType,
    transport::smtp::authentication::Credentials,
    transport::smtp::client::{Tls, TlsParameters},
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use tracing::{info, warn};

use crate::config::Config;

/// SMTP mailer. If SMTP is not configured, logs email to console instead.
pub struct Mailer {
    from: String,
    transport: Option<AsyncSmtpTransport<Tokio1Executor>>,
}

impl Mailer {
    /// Build the mailer from config, mirroring the Go proxy's TLS policy
    /// (`mailer.go` NewMailer + `starttlsRequired`):
    ///   - In production the mailer refuses to send AUTH credentials and the
    ///     token-bearing body over an un-upgraded connection on EVERY port —
    ///     `ALLOW_INSECURE_SMTP=true` is the explicit dev opt-out for a trusted
    ///     private-network relay.
    ///   - Port 465 is implicit TLS (handshake before the SMTP greeting).
    ///   - Port 587 (RFC 6409 submission) always requires STARTTLS before AUTH,
    ///     regardless of `ALLOW_INSECURE_SMTP`.
    ///   - Other ports only require TLS when `require_tls` (production and not
    ///     opted out); otherwise STARTTLS is opportunistic (used if the server
    ///     advertises it, plaintext accepted if not).
    pub fn from_config(cfg: &Config) -> Self {
        let from = cfg.smtp_from.clone();
        let port = cfg.smtp_port;
        let host = (!cfg.smtp_host.is_empty()).then(|| cfg.smtp_host.clone());
        let user = (!cfg.smtp_user.is_empty()).then(|| cfg.smtp_user.clone());
        let pass = (!cfg.smtp_pass.is_empty()).then(|| cfg.smtp_pass.clone());

        // In production an encrypted channel is required on every port unless the
        // operator explicitly opts into a trusted plaintext relay. Mirror Go's
        // `requireTLS := PgstackEnv == "production" && !AllowInsecureSMTP`.
        let require_tls = cfg.pgstack_env == "production" && !cfg.allow_insecure_smtp;
        // STARTTLS is mandatory on the submission port 587, or whenever require_tls.
        let starttls_required = port == 587 || require_tls;

        let transport = if let (Some(host), Some(user), Some(pass)) = (host, user, pass) {
            let creds = Credentials::new(user, pass);
            let builder = if port == 465 {
                // Implicit TLS.
                AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
            } else if starttls_required {
                // STARTTLS mandatory — fails closed if the server can't upgrade.
                AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
            } else {
                // Plaintext relay: STARTTLS opportunistically, cleartext accepted
                // if unavailable (dev / ALLOW_INSECURE_SMTP only — require_tls is
                // false here). Mirror Go's opportunistic c.StartTLS path.
                TlsParameters::new(host.clone()).map(|params| {
                    AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&host)
                        .tls(Tls::Opportunistic(params))
                })
            };
            match builder {
                Ok(b) => {
                    info!(
                        "SMTP configured: {}:{} (require_tls={})",
                        host, port, require_tls
                    );
                    if cfg.pgstack_env == "production" && cfg.allow_insecure_smtp {
                        warn!("ALLOW_INSECURE_SMTP=true in production — SMTP may send credentials/tokens in plaintext");
                    }
                    Some(b.port(port).credentials(creds).build())
                }
                Err(e) => {
                    warn!("SMTP setup failed: {}", e);
                    None
                }
            }
        } else {
            warn!("SMTP not configured — emails will be logged to console");
            None
        };

        Self { from, transport }
    }

    pub async fn send(&self, to: &str, subject: &str, html_body: &str) -> anyhow::Result<()> {
        if let Some(ref transport) = self.transport {
            let email = Message::builder()
                .from(self.from.parse()?)
                .to(to.parse()?)
                .subject(subject)
                .header(ContentType::TEXT_HTML)
                .body(html_body.to_string())?;
            transport.send(email).await?;
            info!("Email sent to {}: {}", to, subject);
        } else {
            // Dev mode: log instead of send. NEVER log the HTML body — it carries
            // password-reset / magic-link / verification token URLs, and logs are a
            // lower trust boundary than email. (The production validator already
            // rejects EMAIL_ENABLED=true without full SMTP, so this path is dev-only.)
            let _ = html_body;
            info!(
                "EMAIL (dev mode — configure SMTP to send for real)\n  To: {}\n  Subject: {}\n  Body: [redacted — token-bearing; configure SMTP to deliver]",
                to, subject
            );
        }
        Ok(())
    }
}
