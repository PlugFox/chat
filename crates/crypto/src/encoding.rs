//! Canonical byte layouts for formats, AAD and KDF labels (docs/crypto.md,
//! "Identifiers and encoding"): big-endian integers, `u16`-length-prefixed
//! variable fields.

use crate::Error;

pub(crate) struct Writer(Vec<u8>);

impl Writer {
    pub(crate) fn new() -> Self {
        Self(Vec::new())
    }

    pub(crate) fn with_label(label: &[u8]) -> Self {
        Self(label.to_vec())
    }

    pub(crate) fn u8(mut self, v: u8) -> Self {
        self.0.push(v);
        self
    }

    pub(crate) fn u32(mut self, v: u32) -> Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }

    pub(crate) fn i64(mut self, v: i64) -> Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }

    pub(crate) fn bytes(mut self, v: &[u8]) -> Self {
        self.0.extend_from_slice(v);
        self
    }

    pub(crate) fn lp(self, v: &[u8]) -> Result<Self, Error> {
        let len = u16::try_from(v.len()).map_err(|_| Error::TooLarge)?;
        Ok(self.bytes(&len.to_be_bytes()).bytes(v))
    }

    pub(crate) fn finish(self) -> Vec<u8> {
        self.0
    }
}

pub(crate) struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    pub(crate) fn new(buf: &'a [u8]) -> Self {
        Self(buf)
    }

    pub(crate) fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        if self.0.len() < n {
            return Err(Error::Malformed);
        }
        let (head, tail) = self.0.split_at(n);
        self.0 = tail;
        Ok(head)
    }

    pub(crate) fn array<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        let mut out = [0; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }

    pub(crate) fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.array::<1>()?[0])
    }

    pub(crate) fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_be_bytes(self.array()?))
    }

    pub(crate) fn lp(&mut self) -> Result<&'a [u8], Error> {
        let len = u16::from_be_bytes(self.array()?);
        self.take(usize::from(len))
    }

    /// Everything left; at least `min` bytes.
    pub(crate) fn rest(&mut self, min: usize) -> Result<&'a [u8], Error> {
        if self.0.len() < min {
            return Err(Error::Malformed);
        }
        Ok(std::mem::take(&mut self.0))
    }

    pub(crate) fn finish(self) -> Result<(), Error> {
        if self.0.is_empty() { Ok(()) } else { Err(Error::Malformed) }
    }
}

/// Reads the version byte and rejects anything but `expected`.
pub(crate) fn version(r: &mut Reader<'_>, expected: u8) -> Result<(), Error> {
    match r.u8()? {
        v if v == expected => Ok(()),
        v => Err(Error::UnsupportedVersion(v)),
    }
}
