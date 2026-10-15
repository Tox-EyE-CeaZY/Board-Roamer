//! Self-update from GitHub releases. The page decides *whether* there is a newer version (it asks the GitHub API);
//! this module does the part a web page cannot: download the matching build, check it against the release's
//! SHA256SUMS.txt, swap it in place of the running program and start it again.

use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::Command,
    thread,
    time::Duration,
};
use tiny_http::{Header, Request, Response};

/// Keep in sync with ui/js/version.js
pub const REPO: &str = "Tox-EyE-CeaZY/Board-Roamer";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_BYTES: u64 = 250 * 1024 * 1024;

fn json(rq: Request, code: u16, v: serde_json::Value) {
    let _ = rq.respond(
        Response::from_string(v.to_string())
            .with_status_code(code)
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
            .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap()),
    );
}

/// GET /update/info
pub fn info(rq: Request) {
    json(
        rq,
        200,
        serde_json::json!({ "version": VERSION, "os": crate::os::os_name(), "arch": crate::os::arch_name(), "repo": REPO, "selfUpdate": true }),
    );
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(300)).user_agent(&format!("BoardRoamer/{VERSION}")).build()
}

/// The expected hash of `asset` according to the SHA256SUMS.txt published next to it.
fn expected_hash(url: &str) -> Result<String, String> {
    let (dir, asset) = url.rsplit_once('/').ok_or("bad url")?;
    let sums = agent()
        .get(&format!("{dir}/SHA256SUMS.txt"))
        .call()
        .map_err(|e| format!("could not read the checksum list: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    sums.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let (h, n) = (it.next()?, it.next()?);
            (n.trim_start_matches('*') == asset).then(|| h.to_ascii_lowercase())
        })
        .next()
        .ok_or_else(|| format!("{asset} is not in the release's checksum list"))
}

fn download(url: &str, to: &PathBuf) -> Result<String, String> {
    let resp = agent().get(url).call().map_err(|e| format!("download failed: {e}"))?;
    let mut reader = resp.into_reader().take(MAX_BYTES);
    let mut file = fs::File::create(to).map_err(|e| format!("cannot write next to the app ({e}). Download the new version from the releases page instead"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| format!("write failed: {e}"))?;
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn swap_in(exe: &PathBuf, new: &PathBuf) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(new, fs::Permissions::from_mode(0o755));
        fs::rename(new, exe).map_err(|e| format!("could not replace the app: {e}"))
    }
    #[cfg(windows)]
    {
        // a running .exe cannot be overwritten, but it can be renamed
        let old = exe.with_extension("old");
        let _ = fs::remove_file(&old);
        fs::rename(exe, &old).map_err(|e| format!("could not move the old version aside: {e}"))?;
        if let Err(e) = fs::rename(new, exe) {
            let _ = fs::rename(&old, exe); // put things back
            return Err(format!("could not install the new version: {e}"));
        }
        Ok(())
    }
}

/// POST /update/apply   {"url": "https://github.com/<repo>/releases/download/<tag>/<asset>"}
pub fn apply(mut rq: Request) {
    let mut body = String::new();
    let _ = rq.as_reader().take(4096).read_to_string(&mut body);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let url = v["url"].as_str().unwrap_or("").to_string();
    if !url.starts_with(&format!("https://github.com/{REPO}/releases/download/")) {
        return json(rq, 400, serde_json::json!({ "error": "that is not a release of this app" }));
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return json(rq, 500, serde_json::json!({ "error": e.to_string() })),
    };
    let want = match expected_hash(&url) {
        Ok(h) => h,
        Err(e) => return json(rq, 502, serde_json::json!({ "error": e })),
    };
    let new = exe.with_file_name(format!("{}.new", exe.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
    let got = match download(&url, &new) {
        Ok(h) => h,
        Err(e) => {
            let _ = fs::remove_file(&new);
            return json(rq, 502, serde_json::json!({ "error": e }));
        }
    };
    if got != want {
        let _ = fs::remove_file(&new);
        return json(rq, 502, serde_json::json!({ "error": "the download does not match its checksum, so it was thrown away" }));
    }
    if let Err(e) = swap_in(&exe, &new) {
        let _ = fs::remove_file(&new);
        return json(rq, 500, serde_json::json!({ "error": e }));
    }
    json(rq, 200, serde_json::json!({ "ok": true }));
    // answer first, then hand over: the new copy waits for this one to let go of the port
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(600));
        let args: Vec<String> = std::env::args().skip(1).filter(|a| a != "--after-update").collect();
        let _ = Command::new(&exe).args(&args).arg("--after-update").spawn();
        std::process::exit(0);
    });
}
