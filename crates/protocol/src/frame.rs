//! The envelope `[type, id, payload]` in MessagePack (docs/protocol.md,
//! "Envelope" and "Encoding rules").

use std::{fmt, io::Cursor};

use serde::{Serialize, de::DeserializeOwned};

/// The version this build speaks; it travels in `auth`, not in every frame.
pub const PROTOCOL_VERSION: u32 = 1;
/// Versions the server accepts: the current one and, once there is one, the previous.
pub const SUPPORTED_VERSIONS: &[u32] = &[1];
/// The `id` of server events and of errors not tied to a request.
pub const EVENT_ID: u32 = 0;

/// Why a frame or payload could not be read. Carries no input bytes.
#[derive(Debug, PartialEq, Eq)]
pub struct FrameError(&'static str);

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for FrameError {}

/// An incoming frame whose payload is still encoded: the handler for `kind`
/// decodes it into its request type, which rejects unknown fields.
#[derive(Debug)]
pub struct InFrame<'a> {
    pub kind: &'a str,
    pub id: u32,
    payload: &'a [u8],
}

impl<'a> InFrame<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, FrameError> {
        let malformed = FrameError("not a [type, id, payload] array");
        let mut rest = bytes;
        if rmp::decode::read_array_len(&mut rest).map_err(|_| FrameError("not an array"))? != 3 {
            return Err(malformed);
        }
        let (kind, mut rest) =
            rmp::decode::read_str_from_slice(rest).map_err(|_| FrameError("type is not a string"))?;
        let id = rmp::decode::read_int(&mut rest).map_err(|_| FrameError("id is not a u32"))?;
        if rest.is_empty() {
            return Err(malformed);
        }
        Ok(Self { kind, id, payload: rest })
    }

    pub fn payload<T: DeserializeOwned>(&self) -> Result<T, FrameError> {
        decode(self.payload)
    }
}

/// One MessagePack value as `T`, with nothing after it.
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, FrameError> {
    let mut de = rmp_serde::Deserializer::new(Cursor::new(bytes)).with_human_readable();
    let value = T::deserialize(&mut de).map_err(|_| FrameError("invalid payload"))?;
    if usize::try_from(de.get_ref().position()).ok() != Some(bytes.len()) {
        return Err(FrameError("bytes after the payload"));
    }
    Ok(value)
}

/// A whole frame. Structs become maps and UUIDs strings, as the client expects.
pub fn encode<T: Serialize>(kind: &str, id: u32, payload: &T) -> Vec<u8> {
    let mut buf = Vec::with_capacity(64);
    // Writing into a Vec cannot fail, and our payload types always serialize;
    // a failure would be a bug that shows up as a truncated frame in tests.
    let _ = rmp::encode::write_array_len(&mut buf, 3);
    let _ = rmp::encode::write_str(&mut buf, kind);
    let _ = rmp::encode::write_uint(&mut buf, u64::from(id));
    let _ = payload.serialize(&mut rmp_serde::Serializer::new(&mut buf).with_struct_map().with_human_readable());
    buf
}

/// Target size of one `more` part (docs/protocol.md, D-027).
pub const PART_BYTES: usize = 256 * 1024;

/// A response of many items as frames: `more` parts of about `limit` bytes,
/// split between items, then the final `ok` with the rest (possibly none).
/// `wrap` builds the response payload around a run of items.
pub fn encode_parts<I: Serialize, P: Serialize>(
    id: u32,
    items: Vec<I>,
    limit: usize,
    wrap: impl Fn(Vec<I>) -> P,
) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    let mut run = Vec::new();
    let mut size = 0;
    for item in items {
        let item_size = rmp_serde::to_vec_named(&item).map_or(0, |b| b.len());
        if !run.is_empty() && size + item_size > limit {
            frames.push(encode("more", id, &wrap(std::mem::take(&mut run))));
            size = 0;
        }
        size += item_size;
        run.push(item);
    }
    frames.push(encode("ok", id, &wrap(run)));
    frames
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Bytes, Empty, connection::Pong};

    #[test]
    fn frames_parse_in_two_steps() {
        let bytes = encode("ping", 7, &Empty {});
        let frame = InFrame::parse(&bytes).unwrap();
        assert_eq!((frame.kind, frame.id), ("ping", 7));
        assert_eq!(frame.payload::<Empty>().unwrap(), Empty {});
        let unknown_field = encode("ping", 8, &Pong { server_time: 1 });
        assert!(InFrame::parse(&unknown_field).unwrap().payload::<Empty>().is_err());
    }

    #[test]
    fn malformed_envelopes_are_refused() {
        let two = rmp_serde::to_vec(&("ping", 1)).unwrap();
        let four = rmp_serde::to_vec(&("ping", 1, Empty {}, 0)).unwrap();
        let negative_id = rmp_serde::to_vec(&("ping", -1, Empty {})).unwrap();
        let numeric_type = rmp_serde::to_vec(&(1, 1, Empty {})).unwrap();
        for bytes in [&[][..], b"{}", &two, &four, &negative_id, &numeric_type] {
            assert!(InFrame::parse(bytes).is_err(), "{bytes:?}");
        }
        let mut trailing = encode("ping", 1, &Empty {});
        trailing.push(0);
        assert!(InFrame::parse(&trailing).unwrap().payload::<Empty>().is_err());
    }

    #[test]
    fn parts_split_between_items() {
        #[derive(Serialize)]
        struct Page {
            items: Vec<Bytes>,
        }
        let items = || (0..5).map(|i| Bytes(vec![i; 100])).collect::<Vec<_>>();
        let frames = encode_parts(9, items(), 250, |items| Page { items });
        let kinds: Vec<_> = frames.iter().map(|f| InFrame::parse(f).unwrap().kind).collect();
        assert_eq!(kinds, ["more", "more", "ok"]);
        assert!(frames.iter().all(|f| InFrame::parse(f).unwrap().id == 9));
        // An item larger than the limit still travels, alone.
        assert_eq!(encode_parts(1, items(), 10, |items| Page { items }).len(), 5);
        assert_eq!(encode_parts(1, Vec::<Bytes>::new(), 10, |items| Page { items }).len(), 1);
    }

    #[test]
    fn structs_are_maps_bytes_are_bin_uuids_are_strings() {
        #[derive(Serialize)]
        struct Sample {
            data: Bytes,
            id: uuid::Uuid,
        }
        let bytes = encode("x", 1, &Sample { data: Bytes(vec![1, 2]), id: uuid::Uuid::nil() });
        let mut rest = InFrame::parse(&bytes).unwrap().payload;
        assert_eq!(rmp::decode::read_map_len(&mut rest).unwrap(), 2);
        let (key, mut rest) = rmp::decode::read_str_from_slice(rest).unwrap();
        assert_eq!(key, "data");
        assert_eq!(rmp::decode::read_bin_len(&mut rest).unwrap(), 2);
        let (key, rest) = rmp::decode::read_str_from_slice(&rest[2..]).unwrap();
        assert_eq!(key, "id");
        let (id, rest) = rmp::decode::read_str_from_slice(rest).unwrap();
        assert_eq!((id, rest.len()), ("00000000-0000-0000-0000-000000000000", 0));
    }
}
