//! The client's key holder: a [`Vault`] lives in a dedicated Web Worker and is
//! the only place the ARK and scope private keys exist in the browser
//! (docs/crypto.md, "Client worker API"). No method returns key material but
//! a file's content key, for the server during a turn that reads the file
//! (D-101); the values that leave it are public keys, wraps, records, file
//! objects, plaintext the caller asked to open, the recovery words (shown
//! once at setup) and the one-time link secret (shown in the QR code).

use std::collections::HashMap;

use chat_crypto::{
    CryptoRng, Error, PublicKey,
    ark::{Ark, Commitment, WriterKey},
    file::{self, ContentKey},
    ids::{DeviceId, EntryId, FileId, LinkSessionId, LogEntryId, NoteId, NotebookId, ScopeId, UserId, WrapId},
    link::{self, LinkKeyPair, LinkSecret},
    os_rng,
    record::{self, Author, Granularity, Kind, Origin, Place},
    recovery::RecoveryKey,
    scope::{ScopeKeyPair, ScopePublicKey},
    wrap::{ArkWrap, DEVICE_SECRET_LEN, PRF_OUTPUT_LEN, PRF_SALT_LEN, UnlockSecret, WrapMethod},
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

/// The `file.key` flag of an image's original (docs/crypto.md, "Files").
const FILE_ORIGINAL: u8 = 1;

/// Errors cross into JS as `Error` objects whose message is the chat-crypto error.
fn js(e: Error) -> JsError {
    JsError::new(&e.to_string())
}

fn bytes<const N: usize>(v: &[u8], what: &str) -> Result<[u8; N], JsError> {
    v.try_into().map_err(|_| JsError::new(&format!("{what} must be {N} bytes")))
}

/// A secret copied in from JS (PRF output, device secret), wiped on drop.
fn secret<const N: usize>(v: &[u8], what: &str) -> Result<Zeroizing<[u8; N]>, JsError> {
    bytes(v, what).map(Zeroizing::new)
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(v).map_err(|e| JsError::new(&e.to_string()))
}

/// A record kind as the client describes it (docs/crypto.md, kind table).
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum KindSpec {
    #[serde(rename = "chat.title")]
    ChatTitle,
    #[serde(rename = "chat.message", rename_all = "camelCase")]
    ChatMessage { message_id: u32, author: AuthorSpec },
    #[serde(rename = "notebook.name", rename_all = "camelCase")]
    NotebookName {
        #[serde(with = "serde_bytes")]
        notebook_id: Vec<u8>,
    },
    #[serde(rename = "note.title", rename_all = "camelCase")]
    NoteTitle {
        #[serde(with = "serde_bytes")]
        note_id: Vec<u8>,
    },
    #[serde(rename = "note.body", rename_all = "camelCase")]
    NoteBody {
        #[serde(with = "serde_bytes")]
        note_id: Vec<u8>,
    },
    #[serde(rename = "register.value", rename_all = "camelCase")]
    RegisterValue {
        #[serde(with = "serde_bytes")]
        entry_id: Vec<u8>,
        period_start: i64,
        granularity: GranularitySpec,
    },
    #[serde(rename = "profile.value")]
    ProfileValue { attribute: String },
    #[serde(rename = "settings.value")]
    SettingsValue { key: String },
    #[serde(rename = "audit.reason", rename_all = "camelCase")]
    AuditReason {
        #[serde(with = "serde_bytes")]
        log_entry_id: Vec<u8>,
    },
    #[serde(rename = "file.key", rename_all = "camelCase")]
    FileKey {
        #[serde(with = "serde_bytes")]
        file_id: Vec<u8>,
    },
    #[serde(rename = "file.preview", rename_all = "camelCase")]
    FilePreview {
        #[serde(with = "serde_bytes")]
        file_id: Vec<u8>,
    },
    #[serde(rename = "chat.memory")]
    ChatMemory,
    #[serde(rename = "file.description", rename_all = "camelCase")]
    FileDescription {
        #[serde(with = "serde_bytes")]
        file_id: Vec<u8>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum AuthorSpec {
    User,
    Assistant,
    Tool,
    Summary,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum GranularitySpec {
    Instant,
    Hour,
    Day,
}

impl KindSpec {
    fn kind(&self) -> Result<Kind<'_>, JsError> {
        let id = |v: &[u8]| bytes::<16>(v, "id");
        Ok(match self {
            Self::ChatTitle => Kind::ChatTitle,
            Self::ChatMessage { message_id, author } => Kind::ChatMessage {
                message_id: *message_id,
                author: match author {
                    AuthorSpec::User => Author::User,
                    AuthorSpec::Assistant => Author::Assistant,
                    AuthorSpec::Tool => Author::Tool,
                    AuthorSpec::Summary => Author::Summary,
                },
            },
            Self::NotebookName { notebook_id } => {
                Kind::NotebookName { notebook_id: NotebookId::from_bytes(id(notebook_id)?) }
            }
            Self::NoteTitle { note_id } => Kind::NoteTitle { note_id: NoteId::from_bytes(id(note_id)?) },
            Self::NoteBody { note_id } => Kind::NoteBody { note_id: NoteId::from_bytes(id(note_id)?) },
            Self::RegisterValue { entry_id, period_start, granularity } => Kind::RegisterValue {
                entry_id: EntryId::from_bytes(id(entry_id)?),
                period_start: *period_start,
                granularity: match granularity {
                    GranularitySpec::Instant => Granularity::Instant,
                    GranularitySpec::Hour => Granularity::Hour,
                    GranularitySpec::Day => Granularity::Day,
                },
            },
            Self::ProfileValue { attribute } => Kind::ProfileValue { attribute },
            Self::SettingsValue { key } => Kind::SettingsValue { key },
            Self::AuditReason { log_entry_id } => {
                Kind::AuditReason { log_entry_id: LogEntryId::from_bytes(id(log_entry_id)?) }
            }
            Self::FileKey { file_id } => Kind::FileKey { file_id: FileId::from_bytes(id(file_id)?) },
            Self::FilePreview { file_id } => Kind::FilePreview { file_id: FileId::from_bytes(id(file_id)?) },
            Self::ChatMemory => Kind::ChatMemory,
            Self::FileDescription { file_id } => Kind::FileDescription { file_id: FileId::from_bytes(id(file_id)?) },
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Setup {
    /// Shown once; never stored.
    recovery_words: String,
    #[serde(with = "serde_bytes")]
    recovery_wrap: Vec<u8>,
    #[serde(with = "serde_bytes")]
    commitment: Vec<u8>,
    #[serde(with = "serde_bytes")]
    writer_public_key: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewRecovery {
    /// Shown once; never stored.
    recovery_words: String,
    #[serde(with = "serde_bytes")]
    recovery_wrap: Vec<u8>,
}

/// The public parameters of a wrap: what the client needs before it can
/// unlock it (which passkey to ask, with which PRF salt).
#[derive(Serialize)]
#[serde(tag = "method", rename_all = "camelCase")]
enum WrapInfo {
    #[serde(rename_all = "camelCase")]
    Passkey {
        #[serde(with = "serde_bytes")]
        wrap_id: Vec<u8>,
        #[serde(with = "serde_bytes")]
        credential_id: Vec<u8>,
        #[serde(with = "serde_bytes")]
        prf_salt: Vec<u8>,
    },
    #[serde(rename_all = "camelCase")]
    Recovery {
        #[serde(with = "serde_bytes")]
        wrap_id: Vec<u8>,
    },
    #[serde(rename_all = "camelCase")]
    Device {
        #[serde(with = "serde_bytes")]
        wrap_id: Vec<u8>,
        #[serde(with = "serde_bytes")]
        device_id: Vec<u8>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewScope {
    key_version: u32,
    #[serde(with = "serde_bytes")]
    public_key: Vec<u8>,
    #[serde(with = "serde_bytes")]
    wrapped_private_key: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    #[serde(with = "serde_bytes")]
    plaintext: Vec<u8>,
    /// "client" (authenticated with the writer key) or "server".
    origin: &'static str,
}

/// A file being encrypted in pieces: the crypto worker feeds it the
/// plaintext and sends on what comes out, so neither copy is held whole.
/// The content key stays inside (docs/crypto.md, "Client worker API").
#[wasm_bindgen]
#[derive(Debug)]
pub struct FileEncryptor {
    encryptor: Option<file::Encryptor>,
    header: Option<Vec<u8>>,
    key_record: Vec<u8>,
}

#[wasm_bindgen]
impl FileEncryptor {
    /// The content key as a `file.key` record of the file's scope.
    #[wasm_bindgen(getter, js_name = keyRecord)]
    pub fn key_record(&self) -> Vec<u8> {
        self.key_record.clone()
    }

    /// The object's next bytes: the header first, then the chunks the plaintext completed.
    pub fn push(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
        let encryptor = self.encryptor.as_mut().ok_or_else(|| JsError::new("the file is finished"))?;
        let chunks = encryptor.push(plaintext).map_err(js)?;
        let mut out = self.header.take().unwrap_or_default();
        out.extend_from_slice(&chunks);
        Ok(out)
    }

    /// The object's last bytes; the plaintext must have been the length it was started with.
    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        let encryptor = self.encryptor.take().ok_or_else(|| JsError::new("the file is finished"))?;
        let mut out = self.header.take().unwrap_or_default();
        out.extend_from_slice(&encryptor.finish().map_err(js)?);
        Ok(out)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkOffer {
    #[serde(with = "serde_bytes")]
    public_key: Vec<u8>,
    #[serde(with = "serde_bytes")]
    secret: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkRequest {
    #[serde(with = "serde_bytes")]
    public_key: Vec<u8>,
    #[serde(with = "serde_bytes")]
    tag: Vec<u8>,
}

struct Unlocked {
    ark: Ark,
    writer: WriterKey,
}

/// The keys of one signed-in user, held in the worker.
#[wasm_bindgen]
pub struct Vault {
    user: UserId,
    unlocked: Option<Unlocked>,
    scopes: HashMap<(ScopeId, u32), ScopeKeyPair>,
    /// The new device's side of a link in progress.
    link: Option<LinkKeyPair>,
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault").field("unlocked", &self.unlocked.is_some()).finish_non_exhaustive()
    }
}

impl Vault {
    fn unlocked(&self) -> Result<&Unlocked, JsError> {
        self.unlocked.as_ref().ok_or_else(|| JsError::new("vault is locked"))
    }

    fn scope(&self, scope: ScopeId, key_version: u32) -> Result<&ScopeKeyPair, JsError> {
        self.scopes.get(&(scope, key_version)).ok_or_else(|| JsError::new("scope key not loaded"))
    }

    fn set_ark(&mut self, ark: Ark) {
        let writer = ark.writer_key(&self.user);
        self.unlocked = Some(Unlocked { ark, writer });
    }

    fn recovery_with(&self, ark: &Ark, wrap_id: &[u8], rng: &mut impl CryptoRng) -> Result<NewRecovery, JsError> {
        let recovery = RecoveryKey::generate(rng);
        let wrap = ArkWrap::seal(
            ark,
            &self.user,
            WrapId::from_bytes(bytes(wrap_id, "wrap id")?),
            WrapMethod::Recovery,
            &UnlockSecret::Recovery(&recovery),
            rng,
        )
        .map_err(js)?;
        Ok(NewRecovery { recovery_words: recovery.to_words().to_string(), recovery_wrap: wrap.encode().map_err(js)? })
    }

    fn setup_with(&mut self, recovery_wrap_id: &[u8], rng: &mut impl CryptoRng) -> Result<Setup, JsError> {
        let ark = Ark::generate(rng);
        let recovery = self.recovery_with(&ark, recovery_wrap_id, rng)?;
        let setup = Setup {
            recovery_words: recovery.recovery_words,
            recovery_wrap: recovery.recovery_wrap,
            commitment: ark.commitment(&self.user).0.to_vec(),
            writer_public_key: ark.writer_key(&self.user).public().as_bytes().to_vec(),
        };
        self.set_ark(ark);
        Ok(setup)
    }

    /// A file's content key and whether it is an image's original, from its
    /// `file.key` record, which only a client may have sealed (docs/crypto.md, "Files").
    fn content_key(&self, scope: ScopeId, file: FileId, key_record: &[u8]) -> Result<(ContentKey, bool), JsError> {
        let place = Place { user: self.user, scope, kind: Kind::FileKey { file_id: file } };
        let keys = self.scope(scope, record::key_version(key_record).map_err(js)?)?;
        let (plaintext, origin) =
            record::open(&place, keys, &self.unlocked()?.writer.public(), key_record).map_err(js)?;
        if origin != Origin::Client {
            return Err(js(Error::WrongWriter));
        }
        let (key, flags) = match plaintext.as_slice() {
            [key @ .., flags] if key.len() == 32 => (key, *flags),
            _ => return Err(js(Error::Malformed)),
        };
        Ok((ContentKey::from_bytes(key).map_err(js)?, flags & FILE_ORIGINAL != 0))
    }

    fn unlock_with(&mut self, secret: &UnlockSecret<'_>, wrap: &[u8], commitment: &[u8]) -> Result<(), JsError> {
        let wrap = ArkWrap::decode(wrap).map_err(js)?;
        let ark = wrap.open(&self.user, secret, &Commitment(bytes(commitment, "commitment")?)).map_err(js)?;
        self.set_ark(ark);
        Ok(())
    }
}

#[wasm_bindgen]
impl Vault {
    #[wasm_bindgen(constructor)]
    pub fn new(user_id: &[u8]) -> Result<Vault, JsError> {
        Ok(Self {
            user: UserId::from_bytes(bytes(user_id, "user id")?),
            unlocked: None,
            scopes: HashMap::new(),
            link: None,
        })
    }

    /// First key setup: a new ARK and recovery key; the vault is unlocked afterwards.
    pub fn setup(&mut self, recovery_wrap_id: &[u8]) -> Result<JsValue, JsError> {
        let setup = self.setup_with(recovery_wrap_id, &mut os_rng())?;
        to_js(&setup)
    }

    /// A wrap of the ARK for a passkey, from its PRF output for `prf_salt`.
    #[wasm_bindgen(js_name = passkeyWrap)]
    pub fn passkey_wrap(
        &self,
        wrap_id: &[u8],
        credential_id: &[u8],
        prf_salt: &[u8],
        prf_output: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let unlocked = self.unlocked()?;
        let prf: Zeroizing<[u8; PRF_OUTPUT_LEN]> = secret(prf_output, "PRF output")?;
        let method = WrapMethod::Passkey {
            credential_id: credential_id.to_vec(),
            prf_salt: bytes::<PRF_SALT_LEN>(prf_salt, "PRF salt")?,
        };
        let wrap = ArkWrap::seal(
            &unlocked.ark,
            &self.user,
            WrapId::from_bytes(bytes(wrap_id, "wrap id")?),
            method,
            &UnlockSecret::Prf(&prf),
            &mut os_rng(),
        )
        .map_err(js)?;
        wrap.encode().map_err(js)
    }

    /// A new recovery key and its wrap, replacing the old one once the
    /// server stores it. The words are shown once.
    #[wasm_bindgen(js_name = rotateRecovery)]
    pub fn rotate_recovery(&self, wrap_id: &[u8]) -> Result<JsValue, JsError> {
        let recovery = self.recovery_with(&self.unlocked()?.ark, wrap_id, &mut os_rng())?;
        to_js(&recovery)
    }

    /// A wrap of the ARK under a remembered device's secret. Called by the
    /// worker's own `remember` operation; the secret never reaches the main thread.
    #[wasm_bindgen(js_name = deviceWrap)]
    pub fn device_wrap(&self, wrap_id: &[u8], device_id: &[u8], secret: &[u8]) -> Result<Vec<u8>, JsError> {
        let unlocked = self.unlocked()?;
        let secret: Zeroizing<[u8; DEVICE_SECRET_LEN]> = self::secret(secret, "device secret")?;
        let wrap = ArkWrap::seal(
            &unlocked.ark,
            &self.user,
            WrapId::from_bytes(bytes(wrap_id, "wrap id")?),
            WrapMethod::Device { device_id: DeviceId::from_bytes(bytes(device_id, "device id")?) },
            &UnlockSecret::Device(&secret),
            &mut os_rng(),
        )
        .map_err(js)?;
        wrap.encode().map_err(js)
    }

    #[wasm_bindgen(js_name = unlockWithRecovery)]
    pub fn unlock_with_recovery(&mut self, words: &str, wrap: &[u8], commitment: &[u8]) -> Result<(), JsError> {
        let key = RecoveryKey::from_words(words).map_err(js)?;
        self.unlock_with(&UnlockSecret::Recovery(&key), wrap, commitment)
    }

    #[wasm_bindgen(js_name = unlockWithPrf)]
    pub fn unlock_with_prf(&mut self, prf_output: &[u8], wrap: &[u8], commitment: &[u8]) -> Result<(), JsError> {
        let prf: Zeroizing<[u8; PRF_OUTPUT_LEN]> = secret(prf_output, "PRF output")?;
        self.unlock_with(&UnlockSecret::Prf(&prf), wrap, commitment)
    }

    /// Unlock with a remembered device's secret; called by the worker only.
    #[wasm_bindgen(js_name = unlockWithDeviceSecret)]
    pub fn unlock_with_device_secret(&mut self, secret: &[u8], wrap: &[u8], commitment: &[u8]) -> Result<(), JsError> {
        let secret: Zeroizing<[u8; DEVICE_SECRET_LEN]> = self::secret(secret, "device secret")?;
        self.unlock_with(&UnlockSecret::Device(&secret), wrap, commitment)
    }

    /// Wipes every key (sign-out, idle lock).
    pub fn lock(&mut self) {
        self.unlocked = None;
        self.scopes.clear();
        self.link = None;
    }

    #[wasm_bindgen(js_name = isUnlocked)]
    pub fn is_unlocked(&self) -> bool {
        self.unlocked.is_some()
    }

    #[wasm_bindgen(js_name = writerPublicKey)]
    pub fn writer_public_key(&self) -> Result<Vec<u8>, JsError> {
        Ok(self.unlocked()?.writer.public().as_bytes().to_vec())
    }

    /// A new scope key pair; the private key stays loaded and comes back wrapped for the server.
    #[wasm_bindgen(js_name = createScope)]
    pub fn create_scope(&mut self, scope_id: &[u8]) -> Result<JsValue, JsError> {
        let scope = ScopeId::from_bytes(bytes(scope_id, "scope id")?);
        let mut rng = os_rng();
        let pair = ScopeKeyPair::generate(1, &mut rng);
        let out = NewScope {
            key_version: 1,
            public_key: pair.public().key.as_bytes().to_vec(),
            wrapped_private_key: pair.wrap(&self.unlocked()?.ark, &self.user, &scope, &mut rng),
        };
        self.scopes.insert((scope, 1), pair);
        to_js(&out)
    }

    /// Loads a scope key pair from its wrapped private key.
    #[wasm_bindgen(js_name = loadScope)]
    pub fn load_scope(&mut self, scope_id: &[u8], key_version: u32, wrapped: &[u8]) -> Result<(), JsError> {
        let scope = ScopeId::from_bytes(bytes(scope_id, "scope id")?);
        let pair = ScopeKeyPair::unwrap(&self.unlocked()?.ark, &self.user, &scope, key_version, wrapped).map_err(js)?;
        self.scopes.insert((scope, key_version), pair);
        Ok(())
    }

    /// Seals a client-written record (HPKE auth mode) to a loaded scope.
    pub fn seal(&self, scope_id: &[u8], key_version: u32, kind: JsValue, plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
        let spec: KindSpec = serde_wasm_bindgen::from_value(kind).map_err(|e| JsError::new(&e.to_string()))?;
        let scope = ScopeId::from_bytes(bytes(scope_id, "scope id")?);
        let place = Place { user: self.user, scope, kind: spec.kind()? };
        let to = self.scope(scope, key_version)?.public();
        record::seal_as_client(&place, &to, &self.unlocked()?.writer, plaintext, &mut os_rng()).map_err(js)
    }

    /// Opens a record of a loaded scope; says whether a client or the server wrote it.
    pub fn open(&self, scope_id: &[u8], kind: JsValue, sealed: &[u8]) -> Result<JsValue, JsError> {
        let spec: KindSpec = serde_wasm_bindgen::from_value(kind).map_err(|e| JsError::new(&e.to_string()))?;
        let scope = ScopeId::from_bytes(bytes(scope_id, "scope id")?);
        let place = Place { user: self.user, scope, kind: spec.kind()? };
        let keys = self.scope(scope, record::key_version(sealed).map_err(js)?)?;
        let (plaintext, origin) = record::open(&place, keys, &self.unlocked()?.writer.public(), sealed).map_err(js)?;
        let origin = match origin {
            Origin::Client => "client",
            Origin::Server => "server",
        };
        to_js(&Opened { plaintext: plaintext.to_vec(), origin })
    }

    /// Starts a file's object of `len` bytes under a new content key, and
    /// the key's `file.key` record; an image's `original` is marked so, and
    /// its key is never given out (D-101).
    #[wasm_bindgen(js_name = encryptFileStart)]
    pub fn encrypt_file_start(
        &self,
        scope_id: &[u8],
        key_version: u32,
        file_id: &[u8],
        len: u32,
        original: bool,
    ) -> Result<FileEncryptor, JsError> {
        let scope = ScopeId::from_bytes(bytes(scope_id, "scope id")?);
        let file_id = FileId::from_bytes(bytes(file_id, "file id")?);
        let mut rng = os_rng();
        let key = ContentKey::generate(&mut rng);
        let len = usize::try_from(len).map_err(|_| JsError::new("file too large"))?;
        let (encryptor, header) = file::Encryptor::new(&key, self.user, file_id, len, &mut rng).map_err(js)?;
        let place = Place { user: self.user, scope, kind: Kind::FileKey { file_id } };
        let to = self.scope(scope, key_version)?.public();
        let mut sealed = Zeroizing::new(Vec::with_capacity(33));
        sealed.extend_from_slice(key.as_bytes());
        sealed.push(if original { FILE_ORIGINAL } else { 0 });
        let key_record =
            record::seal_as_client(&place, &to, &self.unlocked()?.writer, &sealed, &mut rng).map_err(js)?;
        Ok(FileEncryptor { encryptor: Some(encryptor), header: Some(header), key_record })
    }

    /// Opens a file's object with the key its `file.key` record holds.
    #[wasm_bindgen(js_name = decryptFile)]
    pub fn decrypt_file(
        &self,
        scope_id: &[u8],
        file_id: &[u8],
        key_record: &[u8],
        object: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let scope = ScopeId::from_bytes(bytes(scope_id, "scope id")?);
        let file_id = FileId::from_bytes(bytes(file_id, "file id")?);
        let (key, _) = self.content_key(scope, file_id, key_record)?;
        file::decrypt(&key, self.user, file_id, object).map(|pt| pt.to_vec()).map_err(js)
    }

    /// A file's content key, for the server during a turn that reads the
    /// file (D-101): the one key a method returns. It opens this file only,
    /// and never an image's original, which the model does not read.
    #[wasm_bindgen(js_name = fileKey)]
    pub fn file_key(&self, scope_id: &[u8], file_id: &[u8], key_record: &[u8]) -> Result<Vec<u8>, JsError> {
        let scope = ScopeId::from_bytes(bytes(scope_id, "scope id")?);
        let file_id = FileId::from_bytes(bytes(file_id, "file id")?);
        let (key, original) = self.content_key(scope, file_id, key_record)?;
        if original {
            return Err(JsError::new("an original's key is not given out"));
        }
        Ok(key.as_bytes().to_vec())
    }

    /// New device, direction A: the QR content (public key and secret).
    #[wasm_bindgen(js_name = linkOffer)]
    pub fn link_offer(&mut self) -> Result<JsValue, JsError> {
        let mut rng = os_rng();
        let keys = LinkKeyPair::generate(&mut rng);
        let secret = LinkSecret::generate(&mut rng);
        let offer = LinkOffer { public_key: keys.public().as_bytes().to_vec(), secret: secret.as_bytes().to_vec() };
        self.link = Some(keys);
        to_js(&offer)
    }

    /// New device, direction B: its key and the tag proving it saw the QR secret.
    #[wasm_bindgen(js_name = linkRequest)]
    pub fn link_request(&mut self, sid: &[u8], secret: &[u8]) -> Result<JsValue, JsError> {
        let sid = LinkSessionId::from_bytes(bytes(sid, "link session id")?);
        let secret = LinkSecret::from_bytes(bytes(secret, "link secret")?);
        let keys = LinkKeyPair::generate(&mut os_rng());
        let request = LinkRequest {
            public_key: keys.public().as_bytes().to_vec(),
            tag: link::request_tag(&secret, &sid, &keys.public()).to_vec(),
        };
        self.link = Some(keys);
        to_js(&request)
    }

    /// New device: opens the link message; the vault is unlocked afterwards.
    #[wasm_bindgen(js_name = linkReceive)]
    pub fn link_receive(
        &mut self,
        sid: &[u8],
        secret: &[u8],
        message: &[u8],
        commitment: &[u8],
    ) -> Result<(), JsError> {
        let keys = self.link.take().ok_or_else(|| JsError::new("no link in progress"))?;
        let sid = LinkSessionId::from_bytes(bytes(sid, "link session id")?);
        let secret = LinkSecret::from_bytes(bytes(secret, "link secret")?);
        let ark =
            link::open_ark(message, &self.user, &sid, &keys, &secret, &Commitment(bytes(commitment, "commitment")?))
                .map_err(js)?;
        self.set_ark(ark);
        Ok(())
    }

    /// Unlocked device: seals the ARK to the new device. In direction B pass the
    /// request `tag`; it is verified first. In direction A pass an empty tag
    /// (the key came through the camera).
    #[wasm_bindgen(js_name = linkSend)]
    pub fn link_send(&self, sid: &[u8], secret: &[u8], recipient: &[u8], tag: &[u8]) -> Result<Vec<u8>, JsError> {
        let sid = LinkSessionId::from_bytes(bytes(sid, "link session id")?);
        let secret = LinkSecret::from_bytes(bytes(secret, "link secret")?);
        let recipient = PublicKey::from_slice(recipient).map_err(js)?;
        if !tag.is_empty() {
            link::verify_request_tag(&secret, &sid, &recipient, tag).map_err(js)?;
        }
        link::seal_ark(&self.unlocked()?.ark, &self.user, &sid, &recipient, &secret, &mut os_rng()).map_err(js)
    }
}

/// A record as the server seals it (base mode) to a scope's public key. The
/// client never writes one; the end-to-end suite's fake server does, with
/// the same code as the real one. It takes only public values.
#[wasm_bindgen(js_name = sealAsServer)]
pub fn seal_as_server(
    user_id: &[u8],
    scope_id: &[u8],
    key_version: u32,
    public_key: &[u8],
    kind: JsValue,
    plaintext: &[u8],
) -> Result<Vec<u8>, JsError> {
    let spec: KindSpec = serde_wasm_bindgen::from_value(kind).map_err(|e| JsError::new(&e.to_string()))?;
    let place = Place {
        user: UserId::from_bytes(bytes(user_id, "user id")?),
        scope: ScopeId::from_bytes(bytes(scope_id, "scope id")?),
        kind: spec.kind()?,
    };
    let to = ScopePublicKey { key_version, key: PublicKey::from_slice(public_key).map_err(js)? };
    record::seal_as_server(&place, &to, plaintext, &mut os_rng()).map_err(js)
}

/// The public parameters of an encoded wrap.
#[wasm_bindgen(js_name = describeWrap)]
pub fn describe_wrap(wrap: &[u8]) -> Result<JsValue, JsError> {
    let wrap = ArkWrap::decode(wrap).map_err(js)?;
    let wrap_id = wrap.wrap_id.as_bytes().to_vec();
    let info = match wrap.method {
        WrapMethod::Passkey { credential_id, prf_salt } => {
            WrapInfo::Passkey { wrap_id, credential_id, prf_salt: prf_salt.to_vec() }
        }
        WrapMethod::Recovery => WrapInfo::Recovery { wrap_id },
        WrapMethod::Device { device_id } => WrapInfo::Device { wrap_id, device_id: device_id.as_bytes().to_vec() },
    };
    to_js(&info)
}

/// Up to `limit` recovery list words starting with `prefix`, space-separated, for input completion.
/// One string rather than an array: the array glue costs more WASM than the function itself.
#[wasm_bindgen(js_name = recoveryCompletions)]
pub fn recovery_completions(prefix: &str, limit: usize) -> String {
    RecoveryKey::completions(prefix, limit).join(" ")
}
