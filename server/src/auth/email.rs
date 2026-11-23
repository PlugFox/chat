//! Sign-in with a code sent by mail (docs/auth.md, "Email code").

use std::{
    fmt,
    sync::{Arc, Mutex, PoisonError},
};

use hmac::{Hmac, KeyInit, Mac};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor, message::Mailbox};
use sha2::Sha256;
use sqlx::PgPool;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::tokens::random;
use crate::config::SmtpConfig;

const CODE_DIGITS: usize = 8;
const CODE_TTL_MINUTES: i32 = 10;
const MAX_ATTEMPTS: i16 = 5;
const RESEND_SECONDS: i32 = 60;
const SENDS_PER_HOUR: i16 = 5;

/// Trimmed, lower-cased, at most 254 characters, a valid address.
pub fn normalize_email(raw: &str) -> Option<String> {
    let email = raw.trim().to_lowercase();
    if email.len() > 254 || email.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    email.parse::<lettre::Address>().ok()?;
    Some(email)
}

/// A random unguessable id (v4), unlike the time-ordered ids of stored rows.
pub(crate) fn random_id() -> Uuid {
    uuid::Builder::from_random_bytes(random::<16>()).into_uuid()
}

/// Eight digits, uniform: values from the top partial block are redrawn.
fn generate_code() -> Zeroizing<String> {
    const SPACE: u32 = 100_000_000;
    const LIMIT: u32 = u32::MAX - u32::MAX % SPACE;
    loop {
        let n = u32::from_be_bytes(random::<4>());
        if n < LIMIT {
            return Zeroizing::new(format!("{:0width$}", n % SPACE, width = CODE_DIGITS));
        }
    }
}

fn code_mac(key: &[u8; 32], pending_id: Uuid, email: &str, code: &str) -> Hmac<Sha256> {
    #[expect(clippy::expect_used, reason = "HMAC takes keys of any length")]
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC key");
    mac.update(pending_id.as_bytes());
    mac.update(email.as_bytes());
    // Fixed length, so the concatenation is unambiguous.
    mac.update(code.as_bytes());
    mac
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mail {
    pub to: String,
    pub subject: String,
    pub body: String,
}

/// Sends mail through SMTP, or keeps it in memory (tests).
#[derive(Clone)]
pub enum Mailer {
    Smtp { transport: AsyncSmtpTransport<Tokio1Executor>, from: Mailbox },
    Capture(Arc<Mutex<Vec<Mail>>>),
}

impl fmt::Debug for Mailer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Smtp { .. } => "Mailer::Smtp",
            Self::Capture(_) => "Mailer::Capture",
        })
    }
}

impl Mailer {
    pub fn smtp(config: &SmtpConfig) -> Result<Self, String> {
        // Errors name the problem only: the URL may hold a password.
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(&config.url)
            .map_err(|_| "CHAT_SMTP_URL cannot be used".to_owned())?
            .build();
        let from = config.from.parse().map_err(|_| "CHAT_SMTP_FROM is not a mailbox".to_owned())?;
        Ok(Self::Smtp { transport, from })
    }

    pub fn capture() -> (Self, Arc<Mutex<Vec<Mail>>>) {
        let sent = Arc::default();
        (Self::Capture(Arc::clone(&sent)), sent)
    }

    pub async fn send(&self, mail: Mail) -> Result<(), String> {
        match self {
            Self::Smtp { transport, from } => {
                let message = Message::builder()
                    .from(from.clone())
                    .to(mail.to.parse().map_err(|_| "invalid recipient".to_owned())?)
                    .subject(mail.subject)
                    .body(mail.body)
                    .map_err(|e| format!("cannot build message: {e}"))?;
                transport
                    .send(message)
                    .await
                    .map(|_| ())
                    .map_err(|e| if e.is_transient() { "transient SMTP error" } else { "SMTP error" }.to_owned())
            }
            Self::Capture(sent) => {
                sent.lock().unwrap_or_else(PoisonError::into_inner).push(mail);
                Ok(())
            }
        }
    }
}

fn message(locale: &str, to: &str, code: &str) -> Mail {
    let (subject, body) = if locale.starts_with("ru") {
        (
            format!("{code} — код для входа в Vault Chat"),
            format!(
                "Ваш код для входа: {code}\n\nОн действует 10 минут. Если вы не запрашивали код, просто проигнорируйте это письмо.\n"
            ),
        )
    } else {
        (
            format!("{code} is your Vault Chat sign-in code"),
            format!(
                "Your sign-in code: {code}\n\nIt is valid for 10 minutes. If you did not ask for it, ignore this message.\n"
            ),
        )
    };
    Mail { to: to.to_owned(), subject, body }
}

#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("not an email address")]
    InvalidEmail,
    #[error("a code was sent less than a minute ago, or too many this hour")]
    TooSoon,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// A pending code, and the mail to send if the address may receive one.
#[derive(Debug)]
pub struct Started {
    pub pending_id: Uuid,
    pub email: String,
    pub mail: Mail,
}

/// Creates or replaces the pending code for an address. Every address gets
/// the same answer; the caller decides whether the mail is sent.
pub async fn start(
    db: &PgPool,
    key: &[u8; 32],
    raw_email: &str,
    locale: &str,
    link_user: Option<Uuid>,
) -> Result<Started, StartError> {
    let email = normalize_email(raw_email).ok_or(StartError::InvalidEmail)?;
    let pending_id = random_id();
    let code = generate_code();
    let mac = code_mac(key, pending_id, &email, &code).finalize().into_bytes();
    let stored: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO email_codes (id, email, code_hmac, sends, window_started_at, sent_at, expires_at, link_user_id)
         VALUES ($1, $2, $3, 1, now(), now(), now() + make_interval(mins => $4), $5)
         ON CONFLICT (email) DO UPDATE SET
             id = EXCLUDED.id, code_hmac = EXCLUDED.code_hmac, attempts = 0,
             sends = CASE WHEN email_codes.window_started_at <= now() - interval '1 hour' THEN 1
                          ELSE email_codes.sends + 1 END,
             window_started_at = CASE WHEN email_codes.window_started_at <= now() - interval '1 hour' THEN now()
                                      ELSE email_codes.window_started_at END,
             sent_at = now(), expires_at = EXCLUDED.expires_at, link_user_id = EXCLUDED.link_user_id
         WHERE email_codes.sent_at <= now() - make_interval(secs => $6)
           AND (email_codes.window_started_at <= now() - interval '1 hour' OR email_codes.sends < $7)
         RETURNING id",
    )
    .bind(pending_id)
    .bind(&email)
    .bind(mac.as_slice())
    .bind(CODE_TTL_MINUTES)
    .bind(link_user)
    .bind(f64::from(RESEND_SECONDS))
    .bind(SENDS_PER_HOUR)
    .fetch_optional(db)
    .await?;
    if stored.is_none() {
        return Err(StartError::TooSoon);
    }
    let mail = message(locale, &email, &code);
    Ok(Started { pending_id, email, mail })
}

#[derive(Debug, thiserror::Error)]
pub enum CodeError {
    #[error("wrong or unknown code")]
    Invalid,
    #[error("code expired or out of attempts")]
    Expired,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Spends one attempt, then compares; redeems the code on a match. Returns
/// the normalized address. `link_user` must match what the code was started for.
pub async fn verify(
    db: &PgPool,
    key: &[u8; 32],
    pending_id: Uuid,
    raw_email: &str,
    code: &str,
    link_user: Option<Uuid>,
) -> Result<String, CodeError> {
    let email = normalize_email(raw_email).ok_or(CodeError::Invalid)?;
    let code = code.trim();
    if code.len() != CODE_DIGITS || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err(CodeError::Invalid);
    }
    // The attempt is spent atomically before the comparison, so parallel
    // guesses each cost one.
    let stored: Option<Vec<u8>> = sqlx::query_scalar(
        "UPDATE email_codes SET attempts = attempts + 1
         WHERE id = $1 AND email = $2 AND link_user_id IS NOT DISTINCT FROM $3
           AND attempts < $4 AND expires_at > now()
         RETURNING code_hmac",
    )
    .bind(pending_id)
    .bind(&email)
    .bind(link_user)
    .bind(MAX_ATTEMPTS)
    .fetch_optional(db)
    .await?;
    let Some(stored) = stored else {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM email_codes WHERE id = $1 AND email = $2 AND link_user_id IS NOT DISTINCT FROM $3)",
        )
        .bind(pending_id)
        .bind(&email)
        .bind(link_user)
        .fetch_one(db)
        .await?;
        return Err(if exists { CodeError::Expired } else { CodeError::Invalid });
    };
    if code_mac(key, pending_id, &email, code).verify_slice(&stored).is_err() {
        return Err(CodeError::Invalid);
    }
    // Single use: of two concurrent correct verifications, one finds no row.
    let redeemed: Option<Uuid> = sqlx::query_scalar("DELETE FROM email_codes WHERE id = $1 RETURNING id")
        .bind(pending_id)
        .fetch_optional(db)
        .await?;
    redeemed.map(|_| email).ok_or(CodeError::Invalid)
}

/// The user who owns a verified address, if any (to attribute audit events).
pub async fn owner_of(db: &PgPool, email: &str) -> sqlx::Result<Option<Uuid>> {
    sqlx::query_scalar("SELECT user_id FROM identities WHERE email = $1 AND email_verified LIMIT 1")
        .bind(email)
        .fetch_optional(db)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_normalized() {
        assert_eq!(normalize_email("  Ann@Example.COM "), Some("ann@example.com".into()));
        for bad in ["", "ann", "ann@", "@example.com", "a b@example.com", "ann@exa mple.com", &"a".repeat(260)] {
            assert_eq!(normalize_email(bad), None, "{bad}");
        }
    }

    #[test]
    fn codes_are_eight_digits() {
        for _ in 0..100 {
            let code = generate_code();
            assert_eq!(code.len(), 8);
            assert!(code.bytes().all(|b| b.is_ascii_digit()));
        }
    }

    #[test]
    fn the_mac_binds_pending_id_address_and_code() {
        let key = [9; 32];
        let id = random_id();
        let mac = code_mac(&key, id, "a@b.c", "12345678").finalize().into_bytes();
        assert!(code_mac(&key, id, "a@b.c", "12345678").verify_slice(&mac).is_ok());
        assert!(code_mac(&key, random_id(), "a@b.c", "12345678").verify_slice(&mac).is_err());
        assert!(code_mac(&key, id, "x@b.c", "12345678").verify_slice(&mac).is_err());
        assert!(code_mac(&key, id, "a@b.c", "12345679").verify_slice(&mac).is_err());
        assert!(code_mac(&[8; 32], id, "a@b.c", "12345678").verify_slice(&mac).is_err());
    }

    #[test]
    fn mail_is_localized_and_carries_no_link() {
        let en = message("en", "a@b.c", "12345678");
        let ru = message("ru-RU", "a@b.c", "12345678");
        assert!(en.subject.contains("12345678") && en.body.contains("12345678"));
        assert!(ru.body.contains("Ваш код"));
        assert!(!en.body.contains("http") && !ru.body.contains("http"));
    }
}
