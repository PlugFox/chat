//! Where the server may send provider requests (docs/protocol.md, "Provider
//! endpoints"). A user-supplied base URL is an SSRF vector, so:
//!
//! - public addresses only, unless the operator allows networks
//!   (`CHAT_PROVIDER_ALLOWED_NETWORKS`, for Ollama on the host or the LAN);
//! - the check runs on the resolved addresses inside the HTTP client's
//!   resolver, so the connection uses exactly the checked addresses (no second
//!   lookup, no DNS rebinding); IP literals are checked before the request;
//! - `http://` reaches operator-allowed networks only; no redirects, no proxy.

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use ipnet::IpNet;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};

use super::ProviderError;

/// The operator's exceptions to "public addresses only".
#[derive(Clone, Debug, Default)]
pub struct AddressPolicy {
    pub allowed: Vec<IpNet>,
}

impl AddressPolicy {
    pub fn parse(list: &str) -> Result<Self, String> {
        let allowed = list
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| {
                s.parse::<IpNet>()
                    .or_else(|_| s.parse::<IpAddr>().map(IpNet::from))
                    .map_err(|_| format!("`{s}` is not an IP address or CIDR network"))
            })
            .collect::<Result<_, _>>()?;
        Ok(Self { allowed })
    }

    fn operator_allowed(&self, ip: IpAddr) -> bool {
        self.allowed.iter().any(|net| net.contains(&ip))
    }

    /// Whether a connection to `ip` is allowed; `public` also admits public addresses.
    pub fn permits(&self, ip: IpAddr, public: bool) -> bool {
        self.operator_allowed(ip) || (public && is_public(ip))
    }
}

/// Globally routable unicast, excluding every special-purpose range an attacker
/// could aim at (loopback, private, link-local incl. cloud metadata, CGNAT,
/// documentation, benchmarking, multicast, reserved).
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let s = v6.segments();
            !(v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (s[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || (s[0] == 0x0064 && s[1] == 0xff9b) // NAT64: could reach IPv4-internal hosts
                || (s[0] == 0x0100 && s[1] == 0 && s[2] == 0 && s[3] == 0) // discard 100::/64
                || s[0] == 0x2002 // 6to4 embeds IPv4
                || (s[0] == 0x2001 && s[1] < 0x0200)) // IETF protocol assignments, Teredo
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..128).contains(&b)) // CGNAT
        || (a == 169 && b == 254) // link-local, cloud metadata
        || (a == 172 && (16..32).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99) // 6to4 relay
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224) // multicast, reserved, broadcast
}

/// Resolves with the system resolver and keeps only permitted addresses.
#[derive(Debug)]
struct CheckingResolver {
    policy: Arc<AddressPolicy>,
    public: bool,
}

impl Resolve for CheckingResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let policy = self.policy.clone();
        let public = self.public;
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let resolved: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let permitted: Vec<SocketAddr> = resolved.into_iter().filter(|a| policy.permits(a.ip(), public)).collect();
            if permitted.is_empty() {
                return Err(Box::new(ProviderError::Blocked) as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(permitted.into_iter()) as Addrs)
        })
    }
}

/// The HTTP clients provider calls go through.
#[derive(Clone, Debug)]
pub struct ProviderHttp {
    policy: Arc<AddressPolicy>,
    /// For `https://`: public or operator-allowed addresses.
    https: reqwest::Client,
    /// For `http://`: operator-allowed addresses only.
    http: reqwest::Client,
}

fn client(policy: &Arc<AddressPolicy>, public: bool) -> reqwest::Client {
    #[expect(clippy::expect_used, reason = "builds only fail on a broken TLS backend, at startup")]
    reqwest::Client::builder()
        .dns_resolver(Arc::new(CheckingResolver { policy: policy.clone(), public }))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        // Between chunks of a streamed answer; long thinking pauses are fine, a dead peer is not.
        .read_timeout(Duration::from_secs(120))
        .user_agent(concat!("vault-chat/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("HTTP client")
}

impl ProviderHttp {
    pub fn new(policy: AddressPolicy) -> Self {
        let policy = Arc::new(policy);
        Self { https: client(&policy, true), http: client(&policy, false), policy }
    }

    /// The client for `url`, after the checks the resolver cannot do.
    pub fn for_url(&self, url: &reqwest::Url) -> Result<&reqwest::Client, ProviderError> {
        let public = match url.scheme() {
            "https" => true,
            "http" => false,
            _ => return Err(ProviderError::InvalidConfig("the base URL must be http(s)")),
        };
        if !url.username().is_empty() || url.password().is_some() {
            return Err(ProviderError::InvalidConfig("the base URL must not contain credentials"));
        }
        // The resolver never sees IP literals; check them here.
        let literal = match url.host() {
            Some(url::Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
            Some(url::Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
            Some(url::Host::Domain(_)) => None,
            None => return Err(ProviderError::InvalidConfig("the base URL has no host")),
        };
        if let Some(ip) = literal
            && !self.policy.permits(ip, public)
        {
            return Err(ProviderError::Blocked);
        }
        Ok(if public { &self.https } else { &self.http })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn special_ranges_are_not_public() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "198.18.0.1",
            "::1",
            "::",
            "fe80::1",
            "fd00:ec2::254",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::a00:1",
            "2002:7f00:1::",
            "2001:db8::1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn operator_networks_are_the_only_exception() {
        let policy = AddressPolicy::parse("127.0.0.1, 192.168.10.0/24").unwrap();
        assert!(policy.permits("127.0.0.1".parse().unwrap(), false));
        assert!(policy.permits("192.168.10.7".parse().unwrap(), false));
        assert!(!policy.permits("192.168.11.7".parse().unwrap(), true));
        assert!(!policy.permits("8.8.8.8".parse().unwrap(), false), "http reaches allowed networks only");
        assert!(policy.permits("8.8.8.8".parse().unwrap(), true));
        assert!(AddressPolicy::parse("nope").is_err());
    }

    #[test]
    fn literal_hosts_and_schemes_are_checked_before_any_request() {
        let http = ProviderHttp::new(AddressPolicy::parse("127.0.0.1").unwrap());
        let check = |u: &str| http.for_url(&u.parse().unwrap()).map(|_| ());
        assert_eq!(check("https://169.254.169.254/v1"), Err(ProviderError::Blocked));
        assert_eq!(check("http://[::1]:11434/v1"), Err(ProviderError::Blocked));
        assert!(check("http://127.0.0.1:11434/v1").is_ok());
        assert!(check("https://api.example.com/v1").is_ok());
        assert!(matches!(check("ftp://example.com"), Err(ProviderError::InvalidConfig(_))));
        assert!(matches!(check("https://user:pw@example.com"), Err(ProviderError::InvalidConfig(_))));
    }
}
