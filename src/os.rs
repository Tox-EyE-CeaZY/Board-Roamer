//! The few things that differ between Windows, macOS and Linux: where files live, how to open a browser or a folder,
//! what this computer is called and which network addresses it has.

use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

/// Spawn a child without flashing a console window (Windows only; a no-op elsewhere).
pub fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

pub fn home() -> PathBuf {
    env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

/// Where the app keeps its own data (the WebView profile, the sync library).
pub fn data_dir() -> PathBuf {
    #[cfg(windows)]
    let base = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = Some(home().join("Library").join("Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| Some(home().join(".local").join("share")));
    let d = base.unwrap_or_else(env::temp_dir).join("BoardRoamer");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn downloads_dir() -> PathBuf {
    home().join("Downloads").join("Board Roamer")
}

/// Open a URL in the default browser.
pub fn open_url(url: &str) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    #[cfg(windows)]
    let _ = quiet(Command::new("rundll32").args(["url.dll,FileProtocolHandler", url])).spawn();
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = Command::new("xdg-open").arg(url).spawn();
}

/// Show a file (selected) or a folder in the system file manager.
pub fn reveal(path: &Path) {
    let dir_of = |p: &Path| p.parent().map(Path::to_path_buf).unwrap_or_else(downloads_dir);
    #[cfg(windows)]
    {
        if path.is_dir() {
            let _ = quiet(Command::new("explorer").arg(path)).spawn();
        } else if path.exists() {
            let _ = quiet(Command::new("explorer").arg(format!("/select,{}", path.display()))).spawn();
        } else {
            let _ = quiet(Command::new("explorer").arg(dir_of(path))).spawn();
        }
    }
    #[cfg(target_os = "macos")]
    {
        if path.is_file() {
            let _ = Command::new("open").arg("-R").arg(path).spawn();
        } else {
            let _ = Command::new("open").arg(if path.is_dir() { path.to_path_buf() } else { dir_of(path) }).spawn();
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(if path.is_dir() { path.to_path_buf() } else { dir_of(path) }).spawn();
    }
}

pub fn computer_name() -> String {
    if let Some(n) = env::var("COMPUTERNAME").ok().or_else(|| env::var("HOSTNAME").ok()).filter(|s| !s.is_empty()) {
        return n;
    }
    quiet(&mut Command::new("hostname"))
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "this computer".into())
}

pub fn os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Names the release assets use: x64, x86, arm64.
pub fn arch_name() -> &'static str {
    match env::consts::ARCH {
        "x86_64" => "x64",
        "x86" => "x86",
        "aarch64" => "arm64",
        other => other,
    }
}

/// IPv4 addresses a phone could reach this computer on. Tailscale first, then ordinary private networks.
pub fn addresses() -> Vec<(String, &'static str)> {
    let out = {
        #[cfg(windows)]
        let r = quiet(&mut Command::new("ipconfig")).output();
        #[cfg(target_os = "macos")]
        let r = Command::new("ifconfig").output();
        #[cfg(all(unix, not(target_os = "macos")))]
        let r = Command::new("ip").args(["-4", "-o", "addr"]).output().or_else(|_| Command::new("ifconfig").output());
        r.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
    };
    let mut found: Vec<(u8, String, &'static str)> = Vec::new();
    for line in out.lines() {
        // every dotted quad on the line, ignoring masks (255.x), prefix lengths (/24) and labels
        for tok in line.split(|c: char| !(c.is_ascii_digit() || c == '.')) {
            let parts: Vec<u8> = tok.split('.').filter_map(|p| p.parse().ok()).collect();
            if parts.len() != 4 || tok.split('.').count() != 4 || parts[0] == 255 || (parts[0] == 0) {
                continue;
            }
            let kind = match (parts[0], parts[1]) {
                (100, 64..=127) => "tailscale",
                (192, 168) | (10, _) | (172, 16..=31) => "lan",
                _ => continue,
            };
            // a netmask such as 255.255.255.0 is skipped above; a broadcast address ends in .255
            if parts[3] == 255 {
                continue;
            }
            found.push((if kind == "tailscale" { 0 } else { 1 }, tok.to_string(), kind));
        }
    }
    found.sort();
    found.dedup();
    found.into_iter().map(|(_, ip, kind)| (ip, kind)).collect()
}
