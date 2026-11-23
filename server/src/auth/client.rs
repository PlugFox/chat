//! What the server observes about a request: client IP behind trusted
//! proxies, country and user agent (docs/auth.md, "Client IP behind proxies",
//! "Country").

use std::{
    net::{IpAddr, SocketAddr},
    path::Path,
    sync::Arc,
};

use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{HeaderMap, header, request::Parts},
};
use ipnet::IpNet;

use crate::{app::AppState, providers::network::is_public};

/// Longest user agent kept; longer ones are cut at a character boundary.
const MAX_USER_AGENT: usize = 512;

/// The client address: the TCP peer, unless the peer is a trusted proxy, in
/// which case `X-Forwarded-For` is walked from the right past trusted hops.
/// The leftmost entry is written by the client and is never believed on its own.
pub fn client_ip(peer: IpAddr, headers: &HeaderMap, trusted: &[IpNet]) -> IpAddr {
    let is_trusted = |ip: &IpAddr| trusted.iter().any(|net| net.contains(ip));
    if !is_trusted(&peer) {
        return peer;
    }
    let mut client = peer;
    // Several headers are one list, in order.
    let hops = headers.get_all("x-forwarded-for").iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(','));
    let hops: Vec<&str> = hops.map(str::trim).filter(|h| !h.is_empty()).collect();
    for hop in hops.iter().rev() {
        let Ok(ip) = hop.parse::<IpAddr>().or_else(|_| hop.parse::<SocketAddr>().map(|s| s.ip())) else {
            // Garbage from somewhere: keep the last address a trusted hop vouched for.
            break;
        };
        client = ip;
        if !is_trusted(&ip) {
            break;
        }
    }
    client
}

/// A place an IP points to, or a place the weather search found.
#[derive(Clone, Debug, PartialEq)]
pub struct Located {
    pub name: String,
    pub country: String,
    pub latitude: f64,
    pub longitude: f64,
}

/// IP lookups from MaxMind-format databases: country (DB-IP Lite Country) and,
/// if the operator adds one, city (DB-IP Lite City).
#[derive(Clone, Default)]
pub struct Geo {
    reader: Option<Arc<maxminddb::Reader<Vec<u8>>>>,
    cities: Option<Arc<maxminddb::Reader<Vec<u8>>>>,
    fixed: Option<Located>,
}

impl std::fmt::Debug for Geo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Geo").field("loaded", &self.reader.is_some()).finish()
    }
}

impl Geo {
    pub fn open(path: &Path) -> Result<Self, maxminddb::MaxMindDbError> {
        Ok(Self { reader: Some(Arc::new(maxminddb::Reader::open_readfile(path)?)), ..Self::default() })
    }

    /// Adds the city database.
    pub fn with_cities(mut self, path: &Path) -> Result<Self, maxminddb::MaxMindDbError> {
        self.cities = Some(Arc::new(maxminddb::Reader::open_readfile(path)?));
        Ok(self)
    }

    /// Every public address at one place, for tests: no database is checked in.
    pub fn fixed(place: Located) -> Self {
        Self { fixed: Some(place), ..Self::default() }
    }

    /// The place `ip` points to; `None` without a city database, for private
    /// addresses and for anything the database does not know.
    pub fn city(&self, ip: IpAddr) -> Option<Located> {
        if !is_public(ip) {
            return None;
        }
        if let Some(place) = &self.fixed {
            return Some(place.clone());
        }
        let result = self.cities.as_ref()?.lookup(ip).ok()?;
        let name: &str = result.decode_path(&maxminddb::path!["city", "names", "en"]).ok()??;
        let country: &str = result.decode_path(&maxminddb::path!["country", "iso_code"]).ok()??;
        let latitude: f64 = result.decode_path(&maxminddb::path!["location", "latitude"]).ok()??;
        let longitude: f64 = result.decode_path(&maxminddb::path!["location", "longitude"]).ok()??;
        // DB-IP adds the district: "Moscow (Tsentralnyy administrativnyy okrug)".
        let name = name.split(" (").next().unwrap_or(name);
        Some(Located { name: name.to_owned(), country: country.to_owned(), latitude, longitude })
    }

    /// ISO 3166-1 alpha-2 code; `None` without a database, for private
    /// addresses and for anything the database does not know.
    pub fn country(&self, ip: IpAddr) -> Option<String> {
        let reader = self.reader.as_ref()?;
        if !is_public(ip) {
            return None;
        }
        let result = reader.lookup(ip).ok()?;
        let code: Option<&str> = result.decode_path(&maxminddb::path!["country", "iso_code"]).ok()??;
        code.filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_uppercase())).map(str::to_owned)
    }
}

/// IP, country and user agent of the current request.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClientInfo {
    pub ip: Option<IpAddr>,
    pub country: Option<String>,
    pub user_agent: Option<String>,
}

impl ClientInfo {
    pub fn observe(state: &AppState, peer: Option<IpAddr>, headers: &HeaderMap) -> Self {
        let ip = peer.map(|peer| client_ip(peer, headers, &state.config.trusted_proxies));
        let country = ip.and_then(|ip| state.auth.geo.country(ip));
        let user_agent = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).map(|ua| {
            let mut end = ua.len().min(MAX_USER_AGENT);
            while !ua.is_char_boundary(end) {
                end -= 1;
            }
            ua[..end].to_owned()
        });
        Self { ip, country, user_agent }
    }
}

impl FromRequestParts<AppState> for ClientInfo {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|ConnectInfo(addr)| addr.ip());
        Ok(Self::observe(state, peer, &parts.headers))
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn xff(values: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for v in values {
            headers.append("x-forwarded-for", HeaderValue::from_str(v).unwrap());
        }
        headers
    }

    fn nets(list: &[&str]) -> Vec<IpNet> {
        list.iter().map(|n| n.parse().unwrap()).collect()
    }

    #[test]
    fn an_untrusted_peer_is_the_client() {
        let headers = xff(&["1.1.1.1"]);
        assert_eq!(client_ip(ip("203.0.113.9"), &headers, &[]), ip("203.0.113.9"));
        assert_eq!(client_ip(ip("203.0.113.9"), &headers, &nets(&["10.0.0.0/8"])), ip("203.0.113.9"));
    }

    #[test]
    fn one_trusted_proxy() {
        let trusted = nets(&["10.0.0.0/8"]);
        // The client claims 1.1.1.1; the proxy appended what it saw.
        let headers = xff(&["1.1.1.1, 198.51.100.7"]);
        assert_eq!(client_ip(ip("10.0.0.2"), &headers, &trusted), ip("198.51.100.7"));
        // No header at all: the proxy itself.
        assert_eq!(client_ip(ip("10.0.0.2"), &HeaderMap::new(), &trusted), ip("10.0.0.2"));
    }

    #[test]
    fn a_chain_of_trusted_proxies() {
        let trusted = nets(&["10.0.0.0/8", "172.16.0.0/12"]);
        let headers = xff(&["6.6.6.6, 198.51.100.7", "172.16.0.5"]);
        assert_eq!(client_ip(ip("10.0.0.2"), &headers, &trusted), ip("198.51.100.7"));
        // Every hop trusted: the leftmost trusted one.
        let headers = xff(&["10.1.1.1, 172.16.0.5"]);
        assert_eq!(client_ip(ip("10.0.0.2"), &headers, &trusted), ip("10.1.1.1"));
    }

    #[test]
    fn garbage_stops_the_walk() {
        let trusted = nets(&["10.0.0.0/8"]);
        let headers = xff(&["1.1.1.1, not-an-ip, 10.0.0.3"]);
        assert_eq!(client_ip(ip("10.0.0.2"), &headers, &trusted), ip("10.0.0.3"));
        let headers = xff(&["[2001:db8::1]:443"]);
        assert_eq!(client_ip(ip("10.0.0.2"), &headers, &trusted), ip("2001:db8::1"));
    }

    #[test]
    fn no_database_no_country() {
        assert_eq!(Geo::default().country(ip("8.8.8.8")), None);
    }
}
