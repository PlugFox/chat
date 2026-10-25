//! Generates `client/src/protocol/generated/protocol.ts` from the Rust types.
//! The test fails when the file is stale; `CHAT_PROTOCOL_REGEN=1 cargo test -p
//! chat-protocol typescript` rewrites it.

#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test code fails loudly")]

use ts_rs::{Config, TS};

use crate::{
    Empty, Request, SUPPORTED_VERSIONS,
    auth::{
        AccessGrant, AuditEntry, AuditPage, EmailStart, EmailStarted, EmailVerify, Identities, IdentityInfo, Providers,
        SessionInfo, SessionUpdate, Sessions,
    },
    close::CloseCode,
    connection::{Auth, AuthOk, AuthRenew, Ping, Pong, Resume},
    error::{ErrorCode, ErrorPayload},
};

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../client/src/protocol/generated/protocol.ts");

struct Out {
    cfg: Config,
    text: String,
}

impl Out {
    fn decl<T: TS>(&mut self) {
        self.text.push_str(&format!("export {}\n", T::decl(&self.cfg)));
    }

    fn request<R: Request>(&mut self) -> String {
        format!(
            "  \"{}\": {{ request: {}; response: {} }};\n",
            R::TYPE,
            R::name(&self.cfg),
            R::Response::name(&self.cfg)
        )
    }
}

fn generate() -> String {
    // i64 values in the protocol are timestamps and periods, well inside 2^53.
    let mut out = Out { cfg: Config::new().with_large_int("number"), text: String::new() };
    out.text.push_str("// Generated from crates/protocol by its `typescript` test. Do not edit.\n\n");
    out.text.push_str(&format!("export const PROTOCOL_VERSION = {};\n\n", crate::PROTOCOL_VERSION));
    debug_assert_eq!(SUPPORTED_VERSIONS.last(), Some(&crate::PROTOCOL_VERSION));

    out.decl::<Empty>();
    out.decl::<ErrorCode>();
    out.decl::<ErrorPayload>();
    out.decl::<Auth>();
    out.decl::<Resume>();
    out.decl::<AuthOk>();
    out.decl::<AuthRenew>();
    out.decl::<Ping>();
    out.decl::<Pong>();

    out.text.push_str("\n// HTTP /auth (docs/auth.md)\n");
    out.decl::<crate::auth::Provider>();
    out.decl::<Providers>();
    out.decl::<EmailStart>();
    out.decl::<EmailStarted>();
    out.decl::<EmailVerify>();
    out.decl::<AccessGrant>();
    out.decl::<SessionUpdate>();
    out.decl::<SessionInfo>();
    out.decl::<Sessions>();
    out.decl::<IdentityInfo>();
    out.decl::<Identities>();
    out.decl::<AuditEntry>();
    out.decl::<AuditPage>();

    out.text.push_str("\nexport const CloseCode = {\n");
    for code in CloseCode::ALL {
        out.text.push_str(&format!("  {code:?}: {},\n", code.code()));
    }
    out.text.push_str("} as const;\n");

    let requests = [out.request::<Auth>(), out.request::<AuthRenew>(), out.request::<Ping>()].concat();
    out.text.push_str("\n/** Every request `type` with its payload and the payload of its `ok` response. */\n");
    out.text.push_str(&format!("export type Requests = {{\n{requests}}};\n"));
    out.text
        .push_str("\n/** Every server event `type` with its payload. */\nexport type Events = Record<never, never>;\n");
    out.text
}

#[test]
fn typescript_bindings_are_fresh() {
    let generated = generate();
    if std::env::var_os("CHAT_PROTOCOL_REGEN").is_some() {
        std::fs::create_dir_all(std::path::Path::new(PATH).parent().unwrap()).unwrap();
        std::fs::write(PATH, &generated).unwrap();
        return;
    }
    let stored = std::fs::read_to_string(PATH).unwrap_or_default();
    assert!(stored == generated, "{PATH} is stale: run CHAT_PROTOCOL_REGEN=1 cargo test -p chat-protocol typescript");
}
