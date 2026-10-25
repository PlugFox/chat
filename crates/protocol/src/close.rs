//! WebSocket close codes (docs/protocol.md, "Close codes").

use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[repr(u16)]
pub enum CloseCode {
    Normal = 1000,
    GoingAway = 1001,
    AuthFailed = 4001,
    AuthTimeout = 4002,
    SessionRevoked = 4003,
    TokenExpired = 4004,
    UnsupportedVersion = 4005,
    PolicyViolation = 4008,
    Superseded = 4009,
}

impl CloseCode {
    pub const ALL: [Self; 9] = [
        Self::Normal,
        Self::GoingAway,
        Self::AuthFailed,
        Self::AuthTimeout,
        Self::SessionRevoked,
        Self::TokenExpired,
        Self::UnsupportedVersion,
        Self::PolicyViolation,
        Self::Superseded,
    ];

    pub fn code(self) -> u16 {
        self as u16
    }
}
