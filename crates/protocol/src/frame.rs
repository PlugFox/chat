use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// The version this build speaks.
pub const PROTOCOL_VERSION: u32 = 1;
/// Versions the server accepts: the current one and, once there is one, the previous.
pub const SUPPORTED_VERSIONS: &[u32] = &[1];

/// An incoming frame with its payload still raw.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InFrame {
    pub v: u32,
    #[serde(default)]
    pub id: Option<u32>,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub payload: Option<Box<RawValue>>,
}

impl InFrame {
    /// The payload as `T`; a missing payload reads as `{}`.
    pub fn payload<T: serde::de::DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_str(self.payload.as_ref().map_or("{}", |p| p.get()))
    }
}

/// An outgoing frame: a response (with `id`) or an event (without).
#[derive(Debug, Serialize)]
pub struct OutFrame<'a, T: Serialize> {
    pub v: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u32>,
    #[serde(rename = "type")]
    pub kind: &'a str,
    pub payload: T,
}

impl<'a, T: Serialize> OutFrame<'a, T> {
    pub fn ok(id: u32, payload: T) -> Self {
        Self { v: PROTOCOL_VERSION, id: Some(id), kind: "ok", payload }
    }

    pub fn event(kind: &'a str, payload: T) -> Self {
        Self { v: PROTOCOL_VERSION, id: None, kind, payload }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Empty;

    #[test]
    fn frames_parse_in_two_steps() {
        let frame: InFrame = serde_json::from_str(r#"{"v":1,"id":7,"type":"ping","payload":{}}"#).unwrap();
        assert_eq!((frame.v, frame.id, frame.kind.as_str()), (1, Some(7), "ping"));
        assert_eq!(frame.payload::<Empty>().unwrap(), Empty {});
        let bare: InFrame = serde_json::from_str(r#"{"v":1,"id":8,"type":"ping"}"#).unwrap();
        assert_eq!(bare.payload::<Empty>().unwrap(), Empty {});
        assert!(serde_json::from_str::<InFrame>(r#"{"v":1,"type":"ping","extra":1}"#).is_err());
        let unknown_field: InFrame = serde_json::from_str(r#"{"v":1,"type":"ping","payload":{"x":1}}"#).unwrap();
        assert!(unknown_field.payload::<Empty>().is_err());
    }

    #[test]
    fn events_have_no_id() {
        let json = serde_json::to_string(&OutFrame::event("x.y", Empty {})).unwrap();
        assert_eq!(json, r#"{"v":1,"type":"x.y","payload":{}}"#);
        let json = serde_json::to_string(&OutFrame::ok(3, Empty {})).unwrap();
        assert_eq!(json, r#"{"v":1,"id":3,"type":"ok","payload":{}}"#);
    }
}
