//! Embeds the git commit for `--version` and the startup log. No build date:
//! it would make two builds of the same commit differ (reproducible builds,
//! docs/threat-model.md N2).

use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok().filter(|o| o.status.success())?;
    let text = String::from_utf8(output.stdout).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn main() {
    // Docker builds have no `.git` (.dockerignore): pass `--build-arg GIT_COMMIT=…`.
    let commit = std::env::var("GIT_COMMIT")
        .ok()
        .filter(|c| !c.trim().is_empty())
        .or_else(|| git(&["rev-parse", "--short=12", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_owned());
    println!("cargo:rustc-env=CHAT_GIT_COMMIT={}", commit.trim());
    println!("cargo:rerun-if-env-changed=GIT_COMMIT");
    if let Some(dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        println!("cargo:rerun-if-changed={dir}/HEAD");
        println!("cargo:rerun-if-changed={dir}/refs/heads");
    }
}
