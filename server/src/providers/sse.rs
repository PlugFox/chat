//! A minimal Server-Sent Events reader (the subset LLM APIs use): `event:` and
//! `data:` fields, events separated by blank lines, `:` comments ignored.
//! Unlike the browser algorithm, an event cut off by the end of the stream
//! is still delivered: some servers end without the final newline, and the
//! adapters check completeness themselves (finish reason, `[DONE]`).

use bytes::Bytes;
use futures_util::{Stream, StreamExt};

use super::ProviderError;

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

pub(super) struct Reader<S> {
    stream: S,
    buffer: Vec<u8>,
    read: usize,
    max: usize,
    ended: bool,
}

impl<S, E> Reader<S>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
{
    pub(super) fn new(stream: S, max: usize) -> Self {
        Self { stream, buffer: Vec::new(), read: 0, max, ended: false }
    }

    /// The next event, or `None` at the end of the stream.
    pub(super) async fn next(&mut self) -> Result<Option<SseEvent>, ProviderError> {
        let mut event = SseEvent::default();
        let mut has_data = false;
        loop {
            while let Some(end) = self.buffer.iter().position(|&b| b == b'\n') {
                let mut line: Vec<u8> = self.buffer.drain(..=end).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                let line = String::from_utf8(line).map_err(|_| ProviderError::Protocol("event stream is not UTF-8"))?;
                if line.is_empty() {
                    if has_data || event.event.is_some() {
                        return Ok(Some(event));
                    }
                    continue;
                }
                if line.starts_with(':') {
                    continue;
                }
                let (field, value) = line.split_once(':').map_or((line.as_str(), ""), |(f, v)| (f, v));
                let value = value.strip_prefix(' ').unwrap_or(value);
                match field {
                    "event" => event.event = Some(value.to_owned()),
                    "data" => {
                        if has_data {
                            event.data.push('\n');
                        }
                        event.data.push_str(value);
                        has_data = true;
                    }
                    _ => {}
                }
            }
            if self.ended {
                return Ok((has_data || event.event.is_some()).then_some(event));
            }
            match self.stream.next().await {
                Some(Ok(chunk)) => {
                    self.read += chunk.len();
                    if self.read > self.max {
                        return Err(ProviderError::TooLarge);
                    }
                    self.buffer.extend_from_slice(&chunk);
                }
                Some(Err(_)) => return Err(ProviderError::Network),
                None => {
                    // Process an unterminated last line, then deliver what is pending.
                    self.ended = true;
                    if !self.buffer.is_empty() {
                        self.buffer.push(b'\n');
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use futures_util::stream;

    use super::*;

    fn reader(chunks: &[&'static str], max: usize) -> Reader<impl Stream<Item = Result<Bytes, ()>> + Unpin> {
        Reader::new(stream::iter(chunks.iter().map(|c| Ok(Bytes::from_static(c.as_bytes()))).collect::<Vec<_>>()), max)
    }

    #[tokio::test]
    async fn parses_split_chunks_comments_and_multiline_data() {
        let mut r =
            reader(&[": ping\n\nevent: a\nda", "ta: {\"x\":1}\r\n\r\ndata: one\ndata: two\n\n", "data: last"], 1000);
        assert_eq!(r.next().await.unwrap(), Some(SseEvent { event: Some("a".into()), data: "{\"x\":1}".into() }));
        assert_eq!(r.next().await.unwrap(), Some(SseEvent { event: None, data: "one\ntwo".into() }));
        assert_eq!(r.next().await.unwrap(), Some(SseEvent { event: None, data: "last".into() }));
        assert_eq!(r.next().await.unwrap(), None);
    }

    #[tokio::test]
    async fn stops_at_the_size_limit() {
        let mut r = reader(&["data: 0123456789\n\n"], 5);
        assert_eq!(r.next().await, Err(ProviderError::TooLarge));
    }
}
