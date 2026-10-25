//! Records: any encrypted value, HPKE-sealed to a scope public key
//! (docs/crypto.md, "Records").
//!
//! ```text
//! record = v=1 || mode || key_version (u32) || enc (32) || ciphertext
//! info   = "vc/v1/record/" || kind name
//! aad    = "vc/v1/record" || user_id || scope_id || key_version || kind code || kind_fields
//! ```

use hpke::{Deserializable, OpModeR, OpModeS, Serializable};
use zeroize::Zeroizing;

use crate::{
    CryptoRng, Error, PublicKey,
    ark::WriterKey,
    encoding::{Reader, Writer, version},
    ids::{EntryId, FileId, LogEntryId, NoteId, NotebookId, ScopeId, UserId},
    kdf::label,
    keys::{Aead, ENC_LEN, EncappedKey, Kdf, Kem},
    padding,
    scope::{ScopeKeyPair, ScopePublicKey},
};

const VERSION: u8 = 1;
const MODE_BASE: u8 = 0;
const MODE_AUTH: u8 = 1;
const TAG_LEN: usize = 16;

/// Who wrote a message in a chat.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Author {
    User = 1,
    Assistant = 2,
    Tool = 3,
    Summary = 4,
}

/// Period granularity of a register entry.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Granularity {
    Instant = 1,
    Hour = 2,
    Day = 3,
}

/// What a record is and where it belongs; everything here is bound by the AAD.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind<'a> {
    ChatTitle,
    ChatMessage { message_id: u32, author: Author },
    NotebookName { notebook_id: NotebookId },
    NoteTitle { note_id: NoteId },
    NoteBody { note_id: NoteId },
    RegisterValue { entry_id: EntryId, period_start: i64, granularity: Granularity },
    ProfileValue { attribute: &'a str },
    SettingsValue { key: &'a str },
    AuditReason { log_entry_id: LogEntryId },
    FileKey { file_id: FileId },
}

/// Who may seal a kind (docs/crypto.md, "Written by").
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AllowedWriter {
    Client,
    Server,
    Either,
}

/// Who sealed an opened record.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Origin {
    /// HPKE auth mode with the user's writer key: one of the user's clients.
    Client,
    /// HPKE base mode: the server (or anyone with the public key).
    Server,
}

impl Kind<'_> {
    fn code(&self) -> u8 {
        match self {
            Self::ChatTitle => 1,
            Self::ChatMessage { .. } => 2,
            Self::NotebookName { .. } => 3,
            Self::NoteTitle { .. } => 4,
            Self::NoteBody { .. } => 5,
            Self::RegisterValue { .. } => 6,
            Self::ProfileValue { .. } => 7,
            Self::SettingsValue { .. } => 8,
            Self::AuditReason { .. } => 9,
            Self::FileKey { .. } => 10,
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Self::ChatTitle => "chat.title",
            Self::ChatMessage { .. } => "chat.message",
            Self::NotebookName { .. } => "notebook.name",
            Self::NoteTitle { .. } => "note.title",
            Self::NoteBody { .. } => "note.body",
            Self::RegisterValue { .. } => "register.value",
            Self::ProfileValue { .. } => "profile.value",
            Self::SettingsValue { .. } => "settings.value",
            Self::AuditReason { .. } => "audit.reason",
            Self::FileKey { .. } => "file.key",
        }
    }

    fn writer(&self) -> AllowedWriter {
        match self {
            Self::ChatMessage { author: Author::User, .. }
            | Self::ChatTitle
            | Self::NotebookName { .. }
            | Self::NoteTitle { .. }
            | Self::NoteBody { .. }
            | Self::RegisterValue { .. }
            | Self::ProfileValue { .. }
            | Self::SettingsValue { .. } => AllowedWriter::Client,
            Self::ChatMessage { .. } | Self::AuditReason { .. } => AllowedWriter::Server,
            Self::FileKey { .. } => AllowedWriter::Either,
        }
    }

    fn fields(&self, w: Writer) -> Result<Writer, Error> {
        Ok(match *self {
            Self::ChatTitle => w,
            Self::ChatMessage { message_id, author } => w.u32(message_id).u8(author as u8),
            Self::NotebookName { notebook_id } => w.bytes(notebook_id.as_bytes()),
            Self::NoteTitle { note_id } | Self::NoteBody { note_id } => w.bytes(note_id.as_bytes()),
            Self::RegisterValue { entry_id, period_start, granularity } => {
                w.bytes(entry_id.as_bytes()).i64(period_start).u8(granularity as u8)
            }
            Self::ProfileValue { attribute } => w.lp(attribute.as_bytes())?,
            Self::SettingsValue { key } => w.lp(key.as_bytes())?,
            Self::AuditReason { log_entry_id } => w.bytes(log_entry_id.as_bytes()),
            Self::FileKey { file_id } => w.bytes(file_id.as_bytes()),
        })
    }
}

/// The place of a record: owner, scope and kind.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Place<'a> {
    pub user: UserId,
    pub scope: ScopeId,
    pub kind: Kind<'a>,
}

impl Place<'_> {
    fn info(&self) -> Vec<u8> {
        Writer::with_label(label::RECORD_INFO).bytes(self.kind.name().as_bytes()).finish()
    }

    fn aad(&self, key_version: u32) -> Result<Vec<u8>, Error> {
        let w = Writer::with_label(label::RECORD)
            .bytes(self.user.as_bytes())
            .bytes(self.scope.as_bytes())
            .u32(key_version)
            .u8(self.kind.code());
        Ok(self.kind.fields(w)?.finish())
    }
}

pub(crate) fn seal(
    place: &Place<'_>,
    to: &ScopePublicKey,
    writer: Option<&WriterKey>,
    plaintext: &[u8],
    rng: &mut impl CryptoRng,
) -> Result<Vec<u8>, Error> {
    let padded = padding::pad(plaintext)?;
    let pk = to.key.to_hpke()?;
    let (mode_byte, mode) = match writer {
        Some(w) => (MODE_AUTH, OpModeS::Auth(w.0.hpke_pair())),
        None => (MODE_BASE, OpModeS::Base),
    };
    let (enc, ct) = hpke::single_shot_seal_with_rng::<Aead, Kdf, Kem>(
        &mode,
        &pk,
        &place.info(),
        &padded,
        &place.aad(to.key_version)?,
        rng,
    )
    .map_err(|_| Error::Malformed)?;
    Ok(Writer::new().u8(VERSION).u8(mode_byte).u32(to.key_version).bytes(&enc.to_bytes()).bytes(&ct).finish())
}

/// Seals a record written by the user's client (HPKE auth mode).
pub fn seal_as_client(
    place: &Place<'_>,
    to: &ScopePublicKey,
    writer: &WriterKey,
    plaintext: &[u8],
    rng: &mut impl CryptoRng,
) -> Result<Vec<u8>, Error> {
    if place.kind.writer() == AllowedWriter::Server {
        return Err(Error::WrongWriter);
    }
    seal(place, to, Some(writer), plaintext, rng)
}

/// Seals a record written by the server (HPKE base mode).
pub fn seal_as_server(
    place: &Place<'_>,
    to: &ScopePublicKey,
    plaintext: &[u8],
    rng: &mut impl CryptoRng,
) -> Result<Vec<u8>, Error> {
    if place.kind.writer() == AllowedWriter::Client {
        return Err(Error::WrongWriter);
    }
    seal(place, to, None, plaintext, rng)
}

/// The key version a record is sealed with, to pick the scope key pair.
pub fn key_version(record: &[u8]) -> Result<u32, Error> {
    let mut r = Reader::new(record);
    version(&mut r, VERSION)?;
    r.u8()?;
    r.u32()
}

/// Opens a record and says who wrote it. `writer` is the user's writer public key.
pub fn open(
    place: &Place<'_>,
    keys: &ScopeKeyPair,
    writer: &PublicKey,
    record: &[u8],
) -> Result<(Zeroizing<Vec<u8>>, Origin), Error> {
    let mut r = Reader::new(record);
    version(&mut r, VERSION)?;
    let mode = r.u8()?;
    let key_version = r.u32()?;
    let enc = EncappedKey::from_bytes(r.take(ENC_LEN)?).map_err(|_| Error::Malformed)?;
    let ct = r.rest(TAG_LEN)?;
    if key_version != keys.key_version {
        return Err(Error::KeyVersion(key_version));
    }
    let allowed = place.kind.writer();
    let (origin, op_mode) = match mode {
        MODE_AUTH if allowed != AllowedWriter::Server => (Origin::Client, OpModeR::Auth(writer.to_hpke()?)),
        MODE_BASE if allowed != AllowedWriter::Client => (Origin::Server, OpModeR::Base),
        MODE_AUTH | MODE_BASE => return Err(Error::Decrypt),
        _ => return Err(Error::Malformed),
    };
    let padded = Zeroizing::new(
        hpke::single_shot_open::<Aead, Kdf, Kem>(
            &op_mode,
            &keys.pair.sk,
            &enc,
            &place.info(),
            ct,
            &place.aad(key_version)?,
        )
        .map_err(|_| Error::Decrypt)?,
    );
    Ok((Zeroizing::new(padding::unpad(&padded)?.to_vec()), origin))
}
