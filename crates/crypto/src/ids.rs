//! 16-byte identifiers (UUIDv7 on the server). The crate treats them as opaque
//! bytes; distinct types keep a note id from being passed as a scope id.

macro_rules! id {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
        pub struct $name([u8; 16]);

        impl $name {
            pub const fn from_bytes(bytes: [u8; 16]) -> Self {
                Self(bytes)
            }

            pub const fn as_bytes(&self) -> &[u8; 16] {
                &self.0
            }
        }
    };
}

id!(
    /// An account.
    UserId
);
id!(
    /// A scope: a key pair and a grant target. A chat's id is its scope id.
    ScopeId
);
id!(
    /// One ARK wrap (one unlock method).
    WrapId
);
id!(
    /// A device-linking session.
    LinkSessionId
);
id!(
    /// A notebook.
    NotebookId
);
id!(
    /// A note.
    NoteId
);
id!(
    /// A register entry.
    EntryId
);
id!(
    /// An access-log entry.
    LogEntryId
);
id!(
    /// A file.
    FileId
);
