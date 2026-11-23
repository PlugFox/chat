//! A token bucket per socket.

use std::time::Instant;

#[derive(Debug)]
pub(crate) struct Bucket {
    tokens: f64,
    burst: f64,
    per_second: f64,
    last: Instant,
}

impl Bucket {
    pub(crate) fn new(burst: u32, per_second: u32) -> Self {
        Self {
            tokens: f64::from(burst),
            burst: f64::from(burst),
            per_second: f64::from(per_second),
            last: Instant::now(),
        }
    }

    /// Takes one token; false when the socket is over its rate.
    pub(crate) fn take(&mut self) -> bool {
        let now = Instant::now();
        self.tokens = (self.tokens + now.duration_since(self.last).as_secs_f64() * self.per_second).min(self.burst);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}
