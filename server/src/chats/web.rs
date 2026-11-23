//! `web_fetch` (docs/protocol.md, "Agent tools (v1)"; D-114): one `GET` of a
//! public `https://` page for a turn. It goes through the provider module's
//! SSRF checks with no operator exceptions, follows no redirect (another host
//! needs its own approval), sends no cookies and returns text within limits.

use std::time::Duration;

use futures_util::StreamExt as _;
use reqwest::{Url, header};
use serde_json::json;

use super::tools;
use crate::providers::ProviderHttp;

/// The longest address the model may ask for.
pub const URL_MAX: usize = 2048;
/// The whole fetch, so a slow site cannot hold the turn's lease past its renewal.
const TIME_MAX: Duration = Duration::from_secs(10);
/// Bytes read of a body; a page past it is cut.
const BODY_MAX: usize = 2 * 1024 * 1024;
/// Bytes of text the model gets.
const TEXT_MAX: usize = 32 * 1024;

/// The address and its host, or the error text the model gets back. Only the
/// default port: a turn is not a port scanner.
pub fn check(text: &str) -> Result<(Url, String), String> {
    if text.len() > URL_MAX {
        return Err(format!("the address is longer than {URL_MAX} bytes"));
    }
    let url = Url::parse(text.trim()).map_err(|_| "url must be a whole https:// address".to_owned())?;
    if url.scheme() != "https" {
        return Err("only https:// addresses can be read".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the address must not hold credentials".into());
    }
    if url.port().is_some() {
        return Err("only the default https port can be read".into());
    }
    let host = url.host_str().ok_or("the address has no host")?.to_owned();
    Ok((url, host))
}

/// What the model gets of a fetch; a failure is the model's to work around.
pub async fn fetch(http: &ProviderHttp, url: &str) -> String {
    let Ok((url, _)) = check(url) else { return tools::error("the address is not valid") };
    let Ok(client) = http.for_url(&url) else { return tools::error("this address is not public") };
    match tokio::time::timeout(TIME_MAX, read(client, url)).await {
        Ok(result) => result,
        Err(_) => tools::error("the site took too long to answer"),
    }
}

async fn read(client: &reqwest::Client, url: Url) -> String {
    let sent = client.get(url.clone()).header(header::ACCEPT, "text/html,text/plain,application/json,*/*;q=0.5").send();
    // Not logged: the address is the user's, and a failure is the site's.
    let Ok(response) = sent.await else { return tools::error("the site could not be reached, or is not public") };
    let status = response.status();
    if status.is_redirection() {
        let location = response.headers().get(header::LOCATION).and_then(|v| v.to_str().ok());
        let target = location.and_then(|l| url.join(l).ok()).map(String::from);
        return json!({ "ok": false, "status": status.as_u16(), "redirect": target }).to_string();
    }
    let kind = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !is_text(&kind) {
        let ok = status.is_success();
        return json!({ "ok": ok, "status": status.as_u16(), "error": "this is not a text page" }).to_string();
    }
    let mut body = Vec::new();
    let mut cut = false;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { return tools::error("the page stopped arriving") };
        let room = BODY_MAX - body.len();
        cut = chunk.len() > room;
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if cut {
            break;
        }
    }
    page(status.as_u16(), &kind, &body, cut)
}

/// The result of an answer of any status: `ok` tells the model whether it got
/// the page, and an error page's text often says why it did not.
fn page(status: u16, kind: &str, body: &[u8], cut: bool) -> String {
    let text = String::from_utf8_lossy(body);
    let text = if kind.contains("html") { html_text(&text) } else { text.into_owned() };
    let end = (0..=TEXT_MAX.min(text.len())).rev().find(|i| text.is_char_boundary(*i)).unwrap_or(0);
    let cut = cut || end < text.len();
    let mut result =
        json!({ "ok": (200..300).contains(&status), "status": status, "type": kind, "text": &text[..end] });
    if cut {
        result["truncated"] = json!(true);
    }
    result.to_string()
}

fn is_text(kind: &str) -> bool {
    kind.starts_with("text/")
        || kind.ends_with("/json")
        || kind.ends_with("+json")
        || kind.ends_with("/xml")
        || kind.ends_with("+xml")
}

/// A page's readable text, to spend the model's tokens on words rather than
/// markup. It only reads: nothing here is rendered, so a page that fools it
/// leaves stray text, and the model takes any text as data.
fn html_text(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let name: String =
            after[1..].chars().take_while(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect();
        let skip = ["script", "style", "noscript", "svg", "head"].contains(&name.as_str());
        let end = if after.starts_with("<!--") {
            after.find("-->").map(|i| i + 3)
        } else if skip {
            let close = format!("</{name}");
            let lower = after.to_ascii_lowercase();
            lower.find(&close).and_then(|i| after[i..].find('>').map(|j| i + j + 1))
        } else {
            after.find('>').map(|i| i + 1)
        };
        let Some(end) = end else {
            rest = "";
            break;
        };
        out.push(' ');
        rest = &after[end..];
    }
    out.push_str(rest);
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    let mut text = String::with_capacity(decoded.len());
    for line in decoded.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if !line.is_empty() {
            text.push_str(&line);
            text.push('\n');
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::AddressPolicy;

    #[test]
    fn only_a_plain_https_address_passes() {
        let (_, host) = check("https://Example.com/a?b=1").unwrap();
        assert_eq!(host, "example.com");
        for bad in [
            "http://example.com",
            "ftp://example.com",
            "file:///etc/passwd",
            "https://user:pw@example.com",
            "https://example.com:8443/",
            "example.com",
            "",
        ] {
            assert!(check(bad).is_err(), "{bad}");
        }
        assert!(check(&format!("https://example.com/{}", "a".repeat(URL_MAX))).is_err());
        // The default port written out is the default port.
        assert!(check("https://example.com:443/").is_ok());
    }

    #[tokio::test]
    async fn addresses_inside_the_network_are_not_reached() {
        // No operator exception applies, whatever the provider policy allows.
        let http = ProviderHttp::new(AddressPolicy::default());
        for url in
            ["https://127.0.0.1/", "https://169.254.169.254/latest/meta-data/", "https://[::1]/", "https://10.0.0.1/"]
        {
            assert!(fetch(&http, url).await.contains("not public"), "{url}");
        }
    }

    #[test]
    fn any_status_reaches_the_model_with_its_text() {
        let page = |status, body: &[u8]| {
            serde_json::from_str::<serde_json::Value>(&page(status, "text/plain", body, false)).unwrap()
        };
        assert_eq!(page(200, b"fine")["ok"], true);
        assert_eq!(page(204, b"")["ok"], true);
        for status in [404, 429, 500] {
            let got = page(status, b"why");
            assert_eq!((&got["ok"], &got["status"], &got["text"]), (&json!(false), &json!(status), &json!("why")));
        }
        // Not UTF-8, and past the limit on a character's boundary.
        assert_eq!(page(200, &[0xff])["text"], "\u{fffd}");
        let long = page(200, "я".repeat(TEXT_MAX).as_bytes());
        assert_eq!(long["truncated"], true);
    }

    #[test]
    fn a_page_reads_as_its_text() {
        let html = "<html><head><title>T</title><style>a{}</style></head><body>\n<!-- x --><h1>Hi &amp; bye</h1>\
                    <script>evil()</script>\n<p>  one   two </p><SCRIPT>x</SCRIPT></body></html>";
        assert_eq!(html_text(html), "Hi & bye\none two\n");
        assert_eq!(html_text("a <unclosed"), "a\n");
    }
}
