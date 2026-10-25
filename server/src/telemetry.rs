//! Logging. `RUST_LOG` filters (default `info`); `CHAT_LOG_FORMAT=json` for
//! log collectors. Log fields carry ids, sizes and outcomes, never user
//! content, tokens or keys (docs/threat-model.md).

use tracing_subscriber::{EnvFilter, fmt, prelude::*};

use crate::config::LogFormat;

pub fn init(format: LogFormat) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let registry = tracing_subscriber::registry().with(filter);
    match format {
        LogFormat::Pretty => registry.with(fmt::layer()).init(),
        // The request span (its id) goes into every event of the request.
        LogFormat::Json => {
            registry.with(fmt::layer().json().flatten_event(true).with_current_span(true).with_span_list(false)).init();
        }
    }
}
