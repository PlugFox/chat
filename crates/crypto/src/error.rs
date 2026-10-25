/// Errors from decoding and opening. Every authentication failure is
/// [`Error::Decrypt`], whatever check failed, so callers cannot become an oracle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("malformed input")]
    Malformed,
    #[error("unsupported format version {0}")]
    UnsupportedVersion(u8),
    #[error("decryption failed")]
    Decrypt,
    #[error("record is sealed with key version {0}")]
    KeyVersion(u32),
    #[error("this kind of record cannot be written by this writer")]
    WrongWriter,
    #[error("the key does not match the account commitment")]
    Commitment,
    #[error("value too large")]
    TooLarge,
    #[error("recovery key must have 12 words")]
    RecoveryLength,
    #[error("recovery key word {0} is not in the word list")]
    RecoveryWord(usize),
    #[error("recovery key checksum does not match")]
    RecoveryChecksum,
}
