//! Who may create an account: `CHAT_SIGNUP_ALLOW` (docs/auth.md, "Who may
//! sign up"). Globs, not regular expressions: an unanchored expression like
//! `.*@example.com` would admit `x@example.com.attacker.net`.

/// Address patterns allowed to sign up; empty means open sign-up.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SignupPolicy {
    patterns: Vec<String>,
}

impl SignupPolicy {
    pub fn parse(list: &str) -> Result<Self, String> {
        let patterns: Vec<String> =
            list.split(',').map(|p| p.trim().to_lowercase()).filter(|p| !p.is_empty()).collect();
        if patterns.iter().any(|p| p == "*") {
            return Ok(Self::default());
        }
        if let Some(bad) = patterns.iter().find(|p| p.chars().any(char::is_whitespace)) {
            return Err(format!("`{bad}` contains whitespace"));
        }
        Ok(Self { patterns })
    }

    pub fn is_open(&self) -> bool {
        self.patterns.is_empty()
    }

    /// Whether a normalized (lower-case) address may create an account.
    pub fn allows(&self, email: &str) -> bool {
        self.is_open() || self.patterns.iter().any(|p| glob(p.as_bytes(), email.as_bytes()))
    }
}

/// `*` matches any run of characters (including none), `?` exactly one; the
/// whole input must match. Iterative with one backtrack point, so linear in
/// practice and never exponential.
fn glob(pattern: &[u8], input: &[u8]) -> bool {
    let (mut p, mut i) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while i < input.len() {
        match pattern.get(p) {
            Some(b'*') => {
                star = Some((p, i));
                p += 1;
            }
            Some(&c) if c == b'?' || c == input[i] => {
                p += 1;
                i += 1;
            }
            _ => match star {
                Some((sp, si)) => {
                    p = sp + 1;
                    i = si + 1;
                    star = Some((sp, si + 1));
                }
                None => return false,
            },
        }
    }
    pattern[p..].iter().all(|&c| c == b'*')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_or_star_is_open() {
        for list in ["", " , ", "*", "a@b.c, *"] {
            let policy = SignupPolicy::parse(list).unwrap();
            assert!(policy.is_open(), "{list}");
            assert!(policy.allows("anyone@anywhere.example"));
        }
    }

    #[test]
    fn patterns_match_the_whole_address() {
        let policy = SignupPolicy::parse("*@Example.com, me@example.org, ?@x.io").unwrap();
        assert!(policy.allows("ann@example.com"));
        assert!(policy.allows("@example.com"));
        assert!(policy.allows("me@example.org"));
        assert!(policy.allows("a@x.io"));
        assert!(!policy.allows("ann@example.com.attacker.net"));
        assert!(!policy.allows("ann@sub.example.org"));
        assert!(!policy.allows("ab@x.io"));
        assert!(!policy.allows("you@example.org"));
    }

    #[test]
    fn globs() {
        assert!(glob(b"a*b*c", b"aXXbYYc"));
        assert!(glob(b"*", b""));
        assert!(glob(b"a**", b"a"));
        assert!(!glob(b"a*b", b"aXXc"));
        assert!(!glob(b"", b"a"));
        // A pattern that is exponential for naive backtracking stays fast.
        let input = "a".repeat(64);
        assert!(!glob(b"a*a*a*a*a*a*a*a*b", input.as_bytes()));
    }

    #[test]
    fn whitespace_inside_a_pattern_is_refused() {
        assert!(SignupPolicy::parse("a b@example.com").is_err());
    }
}
