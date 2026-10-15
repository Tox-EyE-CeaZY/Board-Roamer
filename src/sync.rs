//! Library sync hub. The desktop app keeps one merged copy of the library (boards, follows, trail, settings) on disk.
//! Every device -- this app's own window included -- pulls it, merges its own changes in the browser, and pushes the result
//! back with a revision check. The merging itself lives in ui/js/syncmerge.js; this side is a small, dumb, safe store.
//!
//! The loopback server (the app's own window) can always reach /sync/*. Other devices reach it only while "Share" is on,
//! through a second listener on the network that requires the pairing code.

use std::{
    collections::HashMap,
    fs,
    hash::{BuildHasher, Hasher},
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tiny_http::{Header, Method, Request, Response, Server};

const FIRST_PORT: u16 = 4622;
const MAX_BODY: u64 = 64 * 1024 * 1024;
const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

struct State {
    dir: PathBuf,
    enabled: bool,
    token: String,
    port: u16,
    rev: u64,
    server: Option<Arc<Server>>,
    devices: HashMap<String, u64>,
    fails: Vec<Instant>,
}

static ST: OnceLock<Mutex<State>> = OnceLock::new();

fn st() -> std::sync::MutexGuard<'static, State> {
    ST.get().expect("sync not initialised").lock().unwrap_or_else(|e| e.into_inner())
}

fn hdr(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn reply(rq: Request, code: u16, ctype: &str, body: Vec<u8>, rev: Option<u64>) {
    let mut r = Response::from_data(body)
        .with_status_code(code)
        .with_header(hdr("Content-Type", ctype))
        .with_header(hdr("Cache-Control", "no-store"));
    if let Some(v) = rev {
        r = r.with_header(hdr("X-Rev", &v.to_string()));
    }
    let _ = rq.respond(r);
}

fn json(rq: Request, code: u16, v: serde_json::Value, rev: Option<u64>) {
    reply(rq, code, "application/json", v.to_string().into_bytes(), rev);
}

fn header_val(rq: &Request, name: &str) -> Option<String> {
    rq.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn random_token() -> String {
    let mut out = String::new();
    for i in 0..10 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(now_secs() ^ (i as u64) << 32);
        h.write_usize(&out as *const _ as usize);
        let v = h.finish();
        out.push(ALPHABET[(v % ALPHABET.len() as u64) as usize] as char);
        if i == 4 {
            out.push('-');
        }
    }
    out
}

fn norm(code: &str) -> String {
    code.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

fn same(a: &str, b: &str) -> bool {
    let (a, b) = (norm(a), norm(b));
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn computer_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "this computer".into())
}

fn doc_path(s: &State) -> PathBuf {
    s.dir.join("sync-doc.json")
}

fn save_config(s: &State) {
    let v = serde_json::json!({ "enabled": s.enabled, "token": s.token, "rev": s.rev, "port": s.port });
    let _ = fs::write(s.dir.join("sync-config.json"), v.to_string());
}

pub fn init(dir: PathBuf) {
    let cfg: serde_json::Value = fs::read(dir.join("sync-config.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let state = State {
        dir,
        enabled: cfg["enabled"].as_bool().unwrap_or(false),
        token: cfg["token"].as_str().map(String::from).filter(|t| !t.is_empty()).unwrap_or_else(random_token),
        port: cfg["port"].as_u64().unwrap_or(FIRST_PORT as u64) as u16,
        rev: cfg["rev"].as_u64().unwrap_or(0),
        server: None,
        devices: HashMap::new(),
        fails: Vec::new(),
    };
    let _ = ST.set(Mutex::new(state));
    if st().enabled {
        let _ = start_listener();
    }
}

/// Start the network listener (idempotent). Returns the port it is on.
fn start_listener() -> Result<u16, String> {
    let mut s = st();
    if s.server.is_some() {
        return Ok(s.port);
    }
    let first = if s.port >= FIRST_PORT && s.port < FIRST_PORT + 40 { s.port } else { FIRST_PORT };
    let mut bound = None;
    for p in (first..first + 20).chain(FIRST_PORT..FIRST_PORT + 20) {
        if let Ok(srv) = Server::http(("0.0.0.0", p)) {
            bound = Some((srv, p));
            break;
        }
    }
    let Some((srv, port)) = bound else { return Err("could not open a network port".into()) };
    let srv = Arc::new(srv);
    s.port = port;
    s.server = Some(srv.clone());
    save_config(&s);
    drop(s);
    thread::spawn(move || {
        for rq in srv.incoming_requests() {
            thread::spawn(move || net_request(rq));
        }
    });
    Ok(port)
}

fn stop_listener() {
    let srv = st().server.take();
    if let Some(s) = srv {
        s.unblock();
    }
}

/* ------------------------------------------------------------------ requests */

fn net_request(rq: Request) {
    let url = rq.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();
    if path == "/ping" {
        return reply(rq, 200, "text/plain", b"board-roamer-sync".to_vec(), None);
    }
    if path != "/sync/doc" && path != "/sync/info" {
        return json(rq, 404, serde_json::json!({ "error": "not found" }), None);
    }
    {
        let mut s = st();
        let cut = Instant::now() - Duration::from_secs(60);
        s.fails.retain(|t| *t > cut);
        if s.fails.len() >= 8 {
            drop(s);
            return json(rq, 429, serde_json::json!({ "error": "too many wrong codes, wait a minute" }), None);
        }
    }
    let given = header_val(&rq, "authorization").and_then(|v| v.strip_prefix("Bearer ").map(String::from)).unwrap_or_default();
    let ok = { let s = st(); s.enabled && same(&given, &s.token) };
    if !ok {
        st().fails.push(Instant::now());
        thread::sleep(Duration::from_millis(350));
        return json(rq, 401, serde_json::json!({ "error": "wrong pairing code" }), None);
    }
    let name = header_val(&rq, "x-device").unwrap_or_else(|| "a device".into());
    st().devices.insert(name.chars().take(40).collect(), now_secs());
    doc_request(rq, &path);
}

/// Routes shared by the loopback server (the app's own window) and the network listener.
pub fn local_request(rq: Request, path: &str) {
    match path {
        "/sync/doc" | "/sync/info" => doc_request(rq, path),
        "/sync/config" => config_request(rq),
        _ => json(rq, 404, serde_json::json!({ "error": "not found" }), None),
    }
}

fn doc_request(mut rq: Request, path: &str) {
    if path == "/sync/info" {
        let s = st();
        let bytes = fs::metadata(doc_path(&s)).map(|m| m.len()).unwrap_or(0);
        let v = serde_json::json!({ "app": "board-roamer-sync", "rev": s.rev, "host": computer_name(), "bytes": bytes });
        let rev = s.rev;
        drop(s);
        return json(rq, 200, v, Some(rev));
    }
    match rq.method() {
        Method::Get => {
            let (rev, p) = { let s = st(); (s.rev, doc_path(&s)) };
            match fs::read(&p) {
                Ok(b) if rev > 0 => reply(rq, 200, "application/json", b, Some(rev)),
                _ => reply(rq, 204, "application/json", Vec::new(), Some(0)),
            }
        }
        Method::Put => {
            let want = header_val(&rq, "if-match").and_then(|v| v.trim().parse::<u64>().ok());
            let mut body = Vec::new();
            if rq.as_reader().take(MAX_BODY + 1).read_to_end(&mut body).is_err() || body.len() as u64 > MAX_BODY {
                return json(rq, 413, serde_json::json!({ "error": "too large" }), None);
            }
            if !body.starts_with(b"{") {
                return json(rq, 400, serde_json::json!({ "error": "not a library document" }), None);
            }
            let mut s = st();
            if want != Some(s.rev) {
                let rev = s.rev;
                drop(s);
                return json(rq, 409, serde_json::json!({ "error": "changed meanwhile", "rev": rev }), Some(rev));
            }
            let path = doc_path(&s);
            let tmp = path.with_extension("tmp");
            if fs::write(&tmp, &body).and_then(|_| fs::rename(&tmp, &path)).is_err() {
                drop(s);
                return json(rq, 500, serde_json::json!({ "error": "could not write the library file" }), None);
            }
            s.rev += 1;
            save_config(&s);
            let rev = s.rev;
            drop(s);
            json(rq, 200, serde_json::json!({ "rev": rev }), Some(rev));
        }
        _ => json(rq, 405, serde_json::json!({ "error": "method not allowed" }), None),
    }
}

fn config_request(mut rq: Request) {
    if rq.method() == &Method::Post {
        let mut body = String::new();
        let _ = rq.as_reader().take(4096).read_to_string(&mut body);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        if v["regen"].as_bool() == Some(true) {
            let mut s = st();
            s.token = random_token();
            s.devices.clear();
            save_config(&s);
        }
        if let Some(on) = v["enabled"].as_bool() {
            if on {
                if let Err(e) = start_listener() {
                    return json(rq, 500, serde_json::json!({ "error": e }), None);
                }
                let mut s = st();
                s.enabled = true;
                save_config(&s);
            } else {
                stop_listener();
                let mut s = st();
                s.enabled = false;
                s.devices.clear();
                save_config(&s);
            }
        }
    }
    let s = st();
    let now = now_secs();
    let devices: Vec<_> = s.devices.iter().map(|(n, t)| serde_json::json!({ "name": n, "ago": now.saturating_sub(*t) })).collect();
    let v = serde_json::json!({
        "enabled": s.enabled, "token": s.token, "port": s.port, "host": computer_name(),
        "rev": s.rev, "addrs": addresses(), "devices": devices,
    });
    drop(s);
    json(rq, 200, v, None);
}

/* ------------------------------------------------------------------ this computer's addresses */

fn addresses() -> Vec<serde_json::Value> {
    let mut cmd = std::process::Command::new("ipconfig");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let mut found: Vec<(u8, String)> = Vec::new();
    for line in out.lines() {
        if !line.contains(':') || !line.to_ascii_lowercase().contains("ipv4") && !line.contains('.') {
            continue;
        }
        let tail = line.rsplit(':').next().unwrap_or("").trim();
        let parts: Vec<u8> = tail.split('.').filter_map(|p| p.trim().parse().ok()).collect();
        if parts.len() != 4 || tail.split('.').count() != 4 {
            continue;
        }
        let kind = match (parts[0], parts[1]) {
            (100, 64..=127) => "tailscale",
            (192, 168) | (10, _) => "lan",
            (172, 16..=31) => "lan",
            _ => continue,
        };
        found.push((if kind == "tailscale" { 0 } else { 1 }, format!("{tail}|{kind}")));
    }
    found.sort();
    found.dedup();
    found
        .into_iter()
        .map(|(_, s)| {
            let (ip, kind) = s.split_once('|').unwrap();
            serde_json::json!({ "ip": ip, "kind": kind })
        })
        .collect()
}
