use lettre::{
    message::header::ContentType, transport::smtp::authentication::Credentials, AsyncSmtpTransport,
    AsyncTransport, Message, Tokio1Executor,
};
use tracing::{info, warn};

/// SMTP mailer. If SMTP is not configured, logs email to console instead.
pub struct Mailer {
    from: String,
    transport: Option<AsyncSmtpTransport<Tokio1Executor>>,
}

impl Mailer {
    pub fn from_env() -> Self {
        let from =
            std::env::var("SMTP_FROM").unwrap_or_else(|_| "noreply@pgstack.local".to_string());

        let host = std::env::var("SMTP_HOST").ok();
        let port: u16 = std::env::var("SMTP_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(587);
        let user = std::env::var("SMTP_USER").ok();
        let pass = std::env::var("SMTP_PASS").ok();

        let transport = if let (Some(host), Some(user), Some(pass)) = (host, user, pass) {
            let creds = Credentials::new(user, pass);
            match AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host) {
                Ok(builder) => {
                    info!("SMTP configured: {}:{}", host, port);
                    Some(builder.port(port).credentials(creds).build())
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
