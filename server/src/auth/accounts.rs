//! Users, identities, devices and sessions in PostgreSQL (docs/auth.md):
//! placing a new identity (sign-up, auto-linking), sessions and refresh-token
//! rotation, revocation, linking and account deletion.

use std::time::Duration;

use chat_protocol::auth::{IdentityInfo, SessionInfo, SessionUpdate};
use serde_json::json;
use sqlx::{PgConnection, PgPool};
use subtle::ConstantTimeEq;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{
    Principal, Provider,
    audit::{self, Event, Kind, millis},
    client::ClientInfo,
    signup::SignupPolicy,
    tokens::{Grant, RefreshToken},
};

/// A previous refresh token still works this long after it was rotated, for
/// tabs that refreshed at the same moment (docs/auth.md).
const REFRESH_GRACE_SECONDS: i32 = 10;
/// Account deletion needs a session younger than this.
const REAUTH_MINUTES: i32 = 10;
/// WebSocket sign-ins update `last_seen_at` at most this often.
const TOUCH_MINUTES: i32 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevokeReason {
    SignOut,
    RevokedByUser,
    DeviceReplaced,
    IdentityUnlinked,
    RefreshReused,
    Idle,
}

impl RevokeReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SignOut => "sign_out",
            Self::RevokedByUser => "revoked_by_user",
            Self::DeviceReplaced => "device_replaced",
            Self::IdentityUnlinked => "identity_unlinked",
            Self::RefreshReused => "refresh_reused",
            Self::Idle => "idle",
        }
    }
}

/// An identity as a provider vouched for it.
#[derive(Clone, Debug)]
pub struct NewIdentity {
    pub provider: Provider,
    pub issuer: String,
    pub subject: String,
    /// Normalized (lower-case).
    pub email: Option<String>,
    pub email_verified: bool,
}

impl NewIdentity {
    pub fn email(address: &str) -> Self {
        Self {
            provider: Provider::Email,
            issuer: "email".to_owned(),
            subject: address.to_owned(),
            email: Some(address.to_owned()),
            email_verified: true,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PlaceError {
    #[error("sign-up is closed for this address")]
    SignupClosed,
    #[error("unverified address of an existing account")]
    EmailUnverified,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placed {
    pub user_id: Uuid,
    pub identity_id: Uuid,
    pub created_user: bool,
    pub linked: bool,
}

/// Serializes first sign-ins with the same address, so two of them cannot
/// create two users.
async fn lock_address(conn: &mut PgConnection, email: Option<&str>) -> sqlx::Result<()> {
    if let Some(email) = email {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))").bind(email).execute(conn).await?;
    }
    Ok(())
}

async fn find_identity(conn: &mut PgConnection, new: &NewIdentity) -> sqlx::Result<Option<(Uuid, Uuid)>> {
    sqlx::query_as("SELECT id, user_id FROM identities WHERE kind = $1 AND issuer = $2 AND subject = $3")
        .bind(new.provider.as_str())
        .bind(&new.issuer)
        .bind(&new.subject)
        .fetch_optional(conn)
        .await
}

async fn insert_identity(conn: &mut PgConnection, user_id: Uuid, new: &NewIdentity) -> sqlx::Result<Uuid> {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO identities (id, user_id, kind, issuer, subject, email, email_verified)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(id)
    .bind(user_id)
    .bind(new.provider.as_str())
    .bind(&new.issuer)
    .bind(&new.subject)
    .bind(&new.email)
    .bind(new.email_verified)
    .execute(conn)
    .await?;
    Ok(id)
}

/// Finds or creates the user for a signing-in identity (docs/auth.md,
/// "Account linking"). Run inside a transaction.
pub async fn place(conn: &mut PgConnection, signup: &SignupPolicy, new: &NewIdentity) -> Result<Placed, PlaceError> {
    lock_address(conn, new.email.as_deref()).await?;
    if let Some((identity_id, user_id)) = find_identity(conn, new).await? {
        sqlx::query("UPDATE identities SET last_used_at = now(), email = $2, email_verified = $3 WHERE id = $1")
            .bind(identity_id)
            .bind(&new.email)
            .bind(new.email_verified)
            .execute(&mut *conn)
            .await?;
        return Ok(Placed { user_id, identity_id, created_user: false, linked: false });
    }
    if let Some(email) = &new.email {
        let owner: Option<Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM identities WHERE email = $1 AND email_verified ORDER BY created_at LIMIT 1",
        )
        .bind(email)
        .fetch_optional(&mut *conn)
        .await?;
        match owner {
            Some(user_id) if new.email_verified => {
                let identity_id = insert_identity(conn, user_id, new).await?;
                return Ok(Placed { user_id, identity_id, created_user: false, linked: true });
            }
            // Auto-linking an unverified address would hand the account to
            // whoever created a Google account with it.
            Some(_) => return Err(PlaceError::EmailUnverified),
            None => {}
        }
    }
    let allowed = match (&new.email, new.email_verified) {
        (Some(email), true) => signup.allows(email),
        _ => signup.is_open(),
    };
    if !allowed {
        return Err(PlaceError::SignupClosed);
    }
    let user_id = Uuid::now_v7();
    sqlx::query("INSERT INTO users (id) VALUES ($1)").bind(user_id).execute(&mut *conn).await?;
    let identity_id = insert_identity(conn, user_id, new).await?;
    Ok(Placed { user_id, identity_id, created_user: true, linked: false })
}

#[derive(Debug, thiserror::Error)]
pub enum LinkError {
    #[error("the identity belongs to another account")]
    InUse,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Adds an identity to a signed-in user; `Ok(None)` when it is already theirs.
pub async fn link(conn: &mut PgConnection, user_id: Uuid, new: &NewIdentity) -> Result<Option<Uuid>, LinkError> {
    lock_address(conn, new.email.as_deref()).await?;
    match find_identity(conn, new).await? {
        Some((_, owner)) if owner == user_id => Ok(None),
        Some(_) => Err(LinkError::InUse),
        None => {
            if let Some(email) = new.email.as_ref().filter(|_| new.email_verified) {
                let other: Option<Uuid> = sqlx::query_scalar(
                    "SELECT user_id FROM identities WHERE email = $1 AND email_verified AND user_id <> $2 LIMIT 1",
                )
                .bind(email)
                .bind(user_id)
                .fetch_optional(&mut *conn)
                .await?;
                if other.is_some() {
                    return Err(LinkError::InUse);
                }
            }
            Ok(Some(insert_identity(conn, user_id, new).await?))
        }
    }
}

/// A new session and the refresh token that goes into the cookie.
#[derive(Debug)]
pub struct NewSession {
    pub grant: Grant,
    pub refresh: RefreshToken,
}

pub async fn create_session(
    conn: &mut PgConnection,
    placed: Placed,
    provider: Provider,
    client: &ClientInfo,
) -> sqlx::Result<NewSession> {
    let session_id = Uuid::now_v7();
    let (refresh, hash) = RefreshToken::new(session_id, 0);
    sqlx::query(
        "INSERT INTO sessions (id, user_id, identity_id, provider, refresh_hash, ip, country, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6::inet, $7, $8)",
    )
    .bind(session_id)
    .bind(placed.user_id)
    .bind(placed.identity_id)
    .bind(provider.as_str())
    .bind(hash.as_slice())
    .bind(client.ip.map(|ip| ip.to_string()))
    .bind(&client.country)
    .bind(&client.user_agent)
    .execute(conn)
    .await?;
    let grant = Grant { user_id: placed.user_id, session_id, identity_id: placed.identity_id, provider };
    Ok(NewSession { grant, refresh })
}

/// Records a sign-in that created a session, with the account and link events it implies.
pub async fn audit_sign_in(
    conn: &mut PgConnection,
    client: &ClientInfo,
    placed: Placed,
    session: &NewSession,
) -> sqlx::Result<()> {
    let user = placed.user_id;
    let provider = session.grant.provider.as_str();
    if placed.created_user {
        audit::record(conn, client, Event::new(Kind::AccountCreated, user)).await?;
    }
    if placed.linked {
        let details = json!({ "identity_id": placed.identity_id, "provider": provider, "auto": true });
        audit::record(conn, client, Event::new(Kind::IdentityLinked, user).details(details)).await?;
    }
    let details = json!({ "identity_id": placed.identity_id, "provider": provider, "new_user": placed.created_user });
    audit::record(conn, client, Event::new(Kind::SignedIn, user).session(session.grant.session_id).details(details))
        .await
}

#[derive(Debug)]
pub enum Refreshed {
    /// A new token for the cookie.
    Rotated { grant: Grant, refresh: RefreshToken },
    /// The previous token within the grace window: a new access token, the cookie stays.
    Grace { grant: Grant },
}

impl Refreshed {
    pub fn grant(&self) -> Grant {
        match self {
            Self::Rotated { grant, .. } | Self::Grace { grant } => *grant,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RefreshError {
    #[error("no valid session for this refresh token")]
    Invalid,
    #[error("an old refresh token was presented again")]
    Reused { user_id: Uuid, session_id: Uuid },
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

#[derive(sqlx::FromRow)]
struct RefreshRow {
    user_id: Uuid,
    identity_id: Option<Uuid>,
    provider: String,
    refresh_hash: Vec<u8>,
    refresh_generation: i32,
    prev_refresh_hash: Option<Vec<u8>>,
    in_grace: Option<bool>,
    idle: bool,
    revoked: bool,
}

fn equal(a: &[u8], b: &[u8]) -> bool {
    a.ct_eq(b).into()
}

/// Rotates a refresh token (docs/auth.md, "Refresh token").
pub async fn refresh(
    db: &PgPool,
    token: &RefreshToken,
    client: &ClientInfo,
    idle: Duration,
) -> Result<Refreshed, RefreshError> {
    let claim = token.claim().ok_or(RefreshError::Invalid)?;
    let mut tx = db.begin().await?;
    let row: Option<RefreshRow> = sqlx::query_as(
        "SELECT user_id, identity_id, provider, refresh_hash, refresh_generation, prev_refresh_hash,
                rotated_at > now() - make_interval(secs => $2) AS in_grace,
                last_seen_at < now() - make_interval(secs => $3) AS idle,
                revoked_at IS NOT NULL AS revoked
         FROM sessions WHERE id = $1 FOR UPDATE",
    )
    .bind(claim.session_id)
    .bind(f64::from(REFRESH_GRACE_SECONDS))
    .bind(idle.as_secs_f64())
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else { return Err(RefreshError::Invalid) };
    let (Some(identity_id), Some(provider)) = (row.identity_id, Provider::parse(&row.provider)) else {
        return Err(RefreshError::Invalid);
    };
    if row.revoked {
        return Err(RefreshError::Invalid);
    }
    let session_id = claim.session_id;
    let user_id = row.user_id;
    if row.idle {
        revoke_in(&mut tx, user_id, Some(&[session_id]), RevokeReason::Idle, client).await?;
        tx.commit().await?;
        return Err(RefreshError::Invalid);
    }
    let grant = Grant { user_id, session_id, identity_id, provider };
    let generation = u32::try_from(row.refresh_generation).unwrap_or(0);
    let ip = client.ip.map(|ip| ip.to_string());

    if equal(&claim.hash, &row.refresh_hash) {
        let next = generation.saturating_add(1);
        let (refresh, hash) = RefreshToken::new(session_id, next);
        sqlx::query(
            "UPDATE sessions SET prev_refresh_hash = refresh_hash, refresh_hash = $4, refresh_generation = $5,
                rotated_at = now(), last_seen_at = now(), ip = COALESCE($2::inet, ip), country = COALESCE($3, country)
             WHERE id = $1",
        )
        .bind(session_id)
        .bind(&ip)
        .bind(&client.country)
        .bind(hash.as_slice())
        .bind(i32::try_from(next).unwrap_or(i32::MAX))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(Refreshed::Rotated { grant, refresh });
    }
    let previous = row.prev_refresh_hash.as_deref().is_some_and(|prev| equal(&claim.hash, prev));
    if previous && row.in_grace == Some(true) {
        sqlx::query(
            "UPDATE sessions SET last_seen_at = now(), ip = COALESCE($2::inet, ip), country = COALESCE($3, country)
             WHERE id = $1",
        )
        .bind(session_id)
        .bind(&ip)
        .bind(&client.country)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(Refreshed::Grace { grant });
    }
    if previous || claim.generation < generation {
        revoke_in(&mut tx, user_id, Some(&[session_id]), RevokeReason::RefreshReused, client).await?;
        tx.commit().await?;
        return Err(RefreshError::Reused { user_id, session_id });
    }
    Err(RefreshError::Invalid)
}

/// The live session a refresh cookie belongs to, without rotating it: binds
/// a Google link flow to the signed-in browser.
pub async fn session_of(db: &PgPool, token: &RefreshToken) -> sqlx::Result<Option<(Uuid, Uuid)>> {
    type Row = (Uuid, Vec<u8>, Option<Vec<u8>>, Option<bool>);
    let Some(claim) = token.claim() else { return Ok(None) };
    let row: Option<Row> = sqlx::query_as(
        "SELECT user_id, refresh_hash, prev_refresh_hash, rotated_at > now() - make_interval(secs => $2)
         FROM sessions WHERE id = $1 AND revoked_at IS NULL",
    )
    .bind(claim.session_id)
    .bind(f64::from(REFRESH_GRACE_SECONDS))
    .fetch_optional(db)
    .await?;
    Ok(row.and_then(|(user_id, current, prev, in_grace)| {
        let ok = equal(&claim.hash, &current)
            || (in_grace == Some(true) && prev.is_some_and(|prev| equal(&claim.hash, &prev)));
        ok.then_some((claim.session_id, user_id))
    }))
}

/// Revokes the user's live sessions (all, or those in `only`) and audits
/// each. Returns the ids that were live; the caller puts them into the store.
pub async fn revoke_in(
    conn: &mut PgConnection,
    user_id: Uuid,
    only: Option<&[Uuid]>,
    reason: RevokeReason,
    client: &ClientInfo,
) -> sqlx::Result<Vec<Uuid>> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "UPDATE sessions SET revoked_at = now(), revoked_reason = $3
         WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2))
         RETURNING id",
    )
    .bind(user_id)
    .bind(only)
    .bind(reason.as_str())
    .fetch_all(&mut *conn)
    .await?;
    for id in &ids {
        let event = Event::new(Kind::SessionRevoked, user_id)
            .session(*id)
            .details(json!({ "session_id": id, "reason": reason.as_str() }));
        audit::record(conn, client, event).await?;
    }
    Ok(ids)
}

/// Whether the session is live and belongs to the user (the access token may
/// outlive a revocation the store has not seen, e.g. an evicted Redis key).
pub async fn is_live(db: &PgPool, user_id: Uuid, session_id: Uuid) -> sqlx::Result<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL)")
        .bind(session_id)
        .bind(user_id)
        .fetch_one(db)
        .await
}

/// Last-seen, IP and country from a WebSocket sign-in, at most every few minutes.
pub async fn touch(db: &PgPool, session_id: Uuid, client: &ClientInfo) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE sessions SET last_seen_at = now(), ip = COALESCE($2::inet, ip), country = COALESCE($3, country)
         WHERE id = $1 AND revoked_at IS NULL AND last_seen_at < now() - make_interval(mins => $4)",
    )
    .bind(session_id)
    .bind(client.ip.map(|ip| ip.to_string()))
    .bind(&client.country)
    .bind(TOUCH_MINUTES)
    .execute(db)
    .await?;
    Ok(())
}

fn clean(value: Option<&str>, max: usize, allowed: impl Fn(char) -> bool) -> Option<String> {
    value.map(str::trim).filter(|v| !v.is_empty() && v.len() <= max && v.chars().all(&allowed)).map(str::to_owned)
}

/// `PUT /auth/session`: records the device and what only the client knows,
/// and revokes the user's other sessions on the same device.
pub async fn update_session(
    conn: &mut PgConnection,
    principal: &Principal,
    update: &SessionUpdate,
    client: &ClientInfo,
) -> sqlx::Result<Vec<Uuid>> {
    let timezone = clean(update.timezone.as_deref(), 64, |c| c.is_ascii_alphanumeric() || "/_-+".contains(c));
    let timezone = match timezone {
        Some(tz) => {
            let known: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1)")
                .bind(&tz)
                .fetch_one(&mut *conn)
                .await?;
            known.then_some(tz)
        }
        None => None,
    };
    let locale = clean(update.locale.as_deref(), 16, |c| c.is_ascii_alphanumeric() || c == '-');
    let version = clean(update.client_version.as_deref(), 64, |c| c.is_ascii_graphic());
    sqlx::query(
        "INSERT INTO devices (user_id, id) VALUES ($1, $2)
         ON CONFLICT (user_id, id) DO UPDATE SET last_seen_at = now()",
    )
    .bind(principal.user_id)
    .bind(update.device_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "UPDATE sessions SET device_id = $2, timezone = $3, locale = $4, client_version = $5,
            user_agent = COALESCE($6, user_agent)
         WHERE id = $1",
    )
    .bind(principal.session_id)
    .bind(update.device_id)
    .bind(timezone)
    .bind(locale)
    .bind(version)
    .bind(&client.user_agent)
    .execute(&mut *conn)
    .await?;
    let others: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM sessions WHERE user_id = $1 AND device_id = $2 AND id <> $3 AND revoked_at IS NULL",
    )
    .bind(principal.user_id)
    .bind(update.device_id)
    .bind(principal.session_id)
    .fetch_all(&mut *conn)
    .await?;
    if others.is_empty() {
        return Ok(others);
    }
    revoke_in(conn, principal.user_id, Some(&others), RevokeReason::DeviceReplaced, client).await
}

pub async fn sessions(db: &PgPool, principal: &Principal) -> sqlx::Result<Vec<SessionInfo>> {
    type Row = (
        Uuid,
        String,
        Option<Uuid>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        OffsetDateTime,
        OffsetDateTime,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, provider, device_id, user_agent, host(ip), country, timezone, locale, client_version,
                created_at, last_seen_at
         FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_seen_at DESC",
    )
    .bind(principal.user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            Some(SessionInfo {
                id: r.0,
                current: r.0 == principal.session_id,
                provider: Provider::parse(&r.1)?,
                device_id: r.2,
                user_agent: r.3,
                ip: r.4,
                country: r.5,
                timezone: r.6,
                locale: r.7,
                client_version: r.8,
                created_at: millis(r.9),
                last_seen_at: millis(r.10),
            })
        })
        .collect())
}

pub async fn identities(db: &PgPool, user_id: Uuid) -> sqlx::Result<Vec<IdentityInfo>> {
    type Row = (Uuid, String, Option<String>, bool, OffsetDateTime, OffsetDateTime);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, kind, email, email_verified, created_at, last_used_at
         FROM identities WHERE user_id = $1 ORDER BY created_at",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            Some(IdentityInfo {
                id: r.0,
                provider: Provider::parse(&r.1)?,
                email: r.2,
                email_verified: r.3,
                created_at: millis(r.4),
                last_used_at: millis(r.5),
            })
        })
        .collect())
}

#[derive(Debug, thiserror::Error)]
pub enum UnlinkError {
    #[error("no such identity")]
    NotFound,
    #[error("the last identity cannot be unlinked")]
    Last,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Removes an identity and revokes the sessions that signed in with it.
pub async fn unlink(
    conn: &mut PgConnection,
    user_id: Uuid,
    identity_id: Uuid,
    client: &ClientInfo,
) -> Result<Vec<Uuid>, UnlinkError> {
    // Locks the user's identities so two concurrent unlinks cannot remove the last two.
    let ids: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id, kind FROM identities WHERE user_id = $1 ORDER BY id FOR UPDATE")
            .bind(user_id)
            .fetch_all(&mut *conn)
            .await?;
    let Some((_, kind)) = ids.iter().find(|(id, _)| *id == identity_id) else { return Err(UnlinkError::NotFound) };
    if ids.len() == 1 {
        return Err(UnlinkError::Last);
    }
    let sessions: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM sessions WHERE identity_id = $1 AND revoked_at IS NULL")
            .bind(identity_id)
            .fetch_all(&mut *conn)
            .await?;
    let revoked = revoke_in(conn, user_id, Some(&sessions), RevokeReason::IdentityUnlinked, client).await?;
    sqlx::query("DELETE FROM identities WHERE id = $1").bind(identity_id).execute(&mut *conn).await?;
    let details = json!({ "identity_id": identity_id, "provider": kind });
    audit::record(conn, client, Event::new(Kind::IdentityUnlinked, user_id).details(details)).await?;
    Ok(revoked)
}

/// Whether the session signed in recently enough to delete the account.
pub async fn recently_signed_in(db: &PgPool, session_id: Uuid) -> sqlx::Result<bool> {
    let recent: Option<bool> =
        sqlx::query_scalar("SELECT created_at > now() - make_interval(mins => $2) FROM sessions WHERE id = $1")
            .bind(session_id)
            .bind(REAUTH_MINUTES)
            .fetch_optional(db)
            .await?;
    Ok(recent == Some(true))
}

pub async fn live_sessions(db: &PgPool, user_id: Uuid) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar("SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL")
        .bind(user_id)
        .fetch_all(db)
        .await
}

/// Deletes the user and, through `ON DELETE CASCADE`, everything they own.
pub async fn delete_user(db: &PgPool, user_id: Uuid) -> sqlx::Result<bool> {
    let deleted = sqlx::query("DELETE FROM users WHERE id = $1").bind(user_id).execute(db).await?;
    Ok(deleted.rows_affected() == 1)
}
