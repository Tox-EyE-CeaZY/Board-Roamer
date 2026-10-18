//! API proxy: allow-listed hosts, per-host rate limiting (e621 asks for <= 2 req/s),
//! short-lived response cache, custom User-Agent and Basic-auth passthrough,
//! plus native "save to Downloads" and "open in default browser".

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::{
    collections::HashMap,
    io::Read,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tiny_http::{Header, Method, Request, Response};

const ALLOWED: &[&str] = &[
    "e621.net",
    "e926.net",
    "donmai.us",
    "gelbooru.com",
    "safebooru.org",
    "rule34.xxx",
    "konachan.com",
    "konachan.net",
    "yande.re",
    "derpibooru.org",
    "derpicdn.net",
];
const DEFAULT_UA: &str = "BoardRoamer/0.1 (personal desktop viewer)";
const CACHE_TTL: Duration = Duration::from_secs(60);

type CacheEntry = (Instant, u16, String, Vec<u8>);
static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
static SLOTS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

use crate::os::{downloads_dir, home, open_url, reveal};

fn hdr(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| percent_decode_str(&v.replace('+', " ")).decode_utf8_lossy().into_owned())
    })
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let host = rest.split(['/', '?', '#']).next()?;
    if host.contains('@') {
        return None;
    }
    Some(host.split(':').next()?.to_ascii_lowercase())
}

fn allowed(host: &str) -> bool {
    ALLOWED.iter().any(|a| host == *a || host.ends_with(&format!(".{a}")))
}

/// Reserve the next free time slot for this host and sleep until it arrives.
fn throttle(host: &str) {
    let gap = if host.ends_with("e621.net") || host.ends_with("e926.net") {
        Duration::from_millis(520)
    } else {
        Duration::from_millis(150)
    };
    // GCRA with a burst of one extra request: two requests may go out back to back,
    // then one per `gap` -- stays inside e621's 2 req/s limit but feels instant.
    let wait = {
        let mut m = SLOTS.get_or_init(Default::default).lock().unwrap();
        let now = Instant::now();
        let tat = m.get(host).copied().filter(|t| *t > now).unwrap_or(now);
        m.insert(host.to_string(), tat + gap);
        (tat.checked_sub(gap).unwrap_or(now)).saturating_duration_since(now)
    };
    if !wait.is_zero() {
        std::thread::sleep(wait);
    }
}

fn reply(rq: Request, code: u16, ctype: &str, body: Vec<u8>) {
    let _ = rq.respond(
        Response::from_data(body)
            .with_status_code(code)
            .with_header(hdr("Content-Type", ctype))
            .with_header(hdr("Cache-Control", "no-store")),
    );
}

fn err(rq: Request, code: u16, msg: &str) {
    let body = format!("{{\"error\":{}}}", serde_json::to_string(msg).unwrap());
    reply(rq, code, "application/json", body.into_bytes());
}

fn header_val(rq: &Request, name: &str) -> Option<String> {
    rq.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

pub fn api(mut rq: Request, query: &str) {
    let Some(target) = param(query, "u") else { return err(rq, 400, "missing u") };
    let Some(host) = host_of(&target) else { return err(rq, 400, "bad url") };
    if !allowed(&host) {
        return err(rq, 403, "host not allowed");
    }
    let method = rq.method().clone();
    let ua = header_val(&rq, "x-br-ua").filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_UA.into());
    let auth = header_val(&rq, "x-br-auth").filter(|s| !s.is_empty());
    let cache_key = format!("{target}|{}", auth.as_deref().unwrap_or(""));

    if method == Method::Get {
        let c = CACHE.get_or_init(Default::default).lock().unwrap();
        if let Some((t, code, ct, body)) = c.get(&cache_key) {
            if t.elapsed() < CACHE_TTL {
                let (code, ct, body) = (*code, ct.clone(), body.clone());
                drop(c);
                return reply(rq, code, &ct, body);
            }
        }
    }

    let mut body = Vec::new();
    let _ = rq.as_reader().read_to_end(&mut body);
    throttle(&host);

    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(25)).build();
    let mut req = agent.request(method.as_str(), &target).set("User-Agent", &ua).set("Accept", "application/json");
    if let Some(a) = &auth {
        req = req.set("Authorization", a);
    }
    let result = if body.is_empty() {
        req.call()
    } else {
        req.set("Content-Type", "application/x-www-form-urlencoded").send_bytes(&body)
    };
    let resp = match result {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return err(rq, 502, &format!("upstream failed: {e}")),
    };
    let code = resp.status();
    let ct = resp.content_type().to_string();
    let mut out = Vec::new();
    let _ = resp.into_reader().take(32 << 20).read_to_end(&mut out);

    if method == Method::Get && code == 200 {
        let mut c = CACHE.get_or_init(Default::default).lock().unwrap();
        if c.len() > 300 {
            c.retain(|_, v| v.0.elapsed() < CACHE_TTL);
            if c.len() > 300 {
                c.clear();
            }
        }
        c.insert(cache_key, (Instant::now(), code, ct.clone(), out.clone()));
    }
    reply(rq, code, &ct, out);
}

fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || "-_. ()".contains(c) { c } else { '_' })
        .collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() { "download".into() } else { s.chars().take(150).collect() }
}

/// POST /save?u=<file url>&name=<filename>  -> saves to Downloads\Board Roamer, returns {"path":...}
pub fn save(mut rq: Request, query: &str) {
    let (Some(target), Some(name)) = (param(query, "u"), param(query, "name")) else {
        return err(rq, 400, "missing params");
    };
    let Some(host) = host_of(&target) else { return err(rq, 400, "bad url") };
    if !allowed(&host) {
        return err(rq, 403, "host not allowed");
    }
    let mut dir = downloads_dir();
    if let Some(sub) = param(query, "dir").filter(|d| !d.trim().is_empty()) {
        dir = dir.join(sanitize(&sub));
    }
    if std::fs::create_dir_all(&dir).is_err() {
        return err(rq, 500, "cannot create downloads folder");
    }
    let mut path = dir.join(sanitize(&name));
    if path.exists() {
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = path.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        path = (2..)
            .map(|n| dir.join(format!("{stem} ({n}){ext}")))
            .find(|p| !p.exists())
            .unwrap();
    }
    let mut raw = Vec::new();
    let _ = rq.as_reader().take(4 << 20).read_to_end(&mut raw);
    let meta: Option<serde_json::Value> = serde_json::from_slice(&raw).ok().filter(|v: &serde_json::Value| v.is_object());
    let ua = header_val(&rq, "x-br-ua").filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_UA.into());
    throttle(&host);
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(120)).build();
    let resp = match agent.get(&target).set("User-Agent", &ua).call() {
        Ok(r) => r,
        Err(e) => return err(rq, 502, &format!("download failed: {e}")),
    };
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut embedded = if meta.is_some() { "none" } else { "off" };
    let mut reader = resp.into_reader();
    if let (Some(m), true) = (&meta, crate::meta::is_image(&ext)) {
        // images are small: hold them in memory, add the metadata, write once
        let mut data = Vec::new();
        if let Err(e) = reader.take(300 << 20).read_to_end(&mut data) {
            return err(rq, 500, &format!("download failed: {e}"));
        }
        let out = match crate::meta::embed_bytes(&ext, &data, m) {
            Some(o) => {
                embedded = "embedded";
                o
            }
            None => data,
        };
        if let Err(e) = std::fs::write(&path, out) {
            return err(rq, 500, &format!("cannot write file: {e}"));
        }
    } else {
        let mut file = match std::fs::File::create(&path) {
            Ok(f) => f,
            Err(e) => return err(rq, 500, &format!("cannot write file: {e}")),
        };
        if let Err(e) = std::io::copy(&mut reader, &mut file) {
            return err(rq, 500, &format!("write failed: {e}"));
        }
        drop(file);
        if let Some(m) = &meta {
            if crate::meta::embed_file(&path, &ext, m) {
                embedded = "embedded";
            }
        }
    }
    if embedded == "none" {
        if let Some(m) = &meta {
            if crate::meta::write_sidecar(&path, m) {
                embedded = "sidecar";
            }
        }
    }
    let body = serde_json::json!({ "path": path.to_string_lossy(), "meta": embedded }).to_string();
    reply(rq, 200, "application/json", body.into_bytes());
}

/// POST /open?u=<http(s) url>  or ?reveal=<path> -> opens in the default browser / file manager.
pub fn open_external(rq: Request, query: &str) {
    if let Some(p) = param(query, "reveal") {
        // "downloads" (or the old %USERPROFILE% spelling) means the app's download folder
        let path = if p == "downloads" || (p.contains("Board Roamer") && p.contains("Downloads")) {
            let _ = std::fs::create_dir_all(downloads_dir());
            downloads_dir()
        } else {
            PathBuf::from(p.replace("%USERPROFILE%", &home().to_string_lossy()))
        };
        reveal(&path);
        return reply(rq, 200, "application/json", b"{}".to_vec());
    }
    match param(query, "u") {
        Some(u) if u.starts_with("http://") || u.starts_with("https://") => {
            open_url(&u);
            reply(rq, 200, "application/json", b"{}".to_vec())
        }
        _ => err(rq, 400, "bad url"),
    }
}

/// POST /notify  {"title":..,"body":..} -> a system notification. Text only; length-capped.
pub fn notify(mut rq: Request) {
    let mut raw = Vec::new();
    let _ = rq.as_reader().take(4096).read_to_end(&mut raw);
    let v: serde_json::Value = serde_json::from_slice(&raw).unwrap_or_default();
    let cap = |k: &str, n: usize| v.get(k).and_then(|x| x.as_str()).unwrap_or("").chars().take(n).collect::<String>();
    let (title, body) = (cap("title", 80), cap("body", 200));
    if title.is_empty() && body.is_empty() {
        return err(rq, 400, "nothing to say");
    }
    crate::os::notify(&title, &body);
    reply(rq, 200, "application/json", b"{}".to_vec());
}

#[allow(dead_code)]
pub fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

/// GET /img?u=<image url> -> fetches with the site's own Referer. Fallback for CDNs that reject hotlinks.
pub fn image(rq: Request, query: &str) {
    let Some(target) = param(query, "u") else { return err(rq, 400, "missing u") };
    let Some(host) = host_of(&target) else { return err(rq, 400, "bad url") };
    if !allowed(&host) {
        return err(rq, 403, "host not allowed");
    }
    let referer = if host.ends_with("e621.net") || host.ends_with("e926.net") {
        "https://e621.net/"
    } else if host.ends_with("donmai.us") {
        "https://danbooru.donmai.us/"
    } else if host.ends_with("gelbooru.com") {
        "https://gelbooru.com/"
    } else if host.ends_with("derpibooru.org") || host.ends_with("derpicdn.net") {
        "https://derpibooru.org/"
    } else {
        "https://safebooru.org/"
    };
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(40)).build();
    let resp = match agent.get(&target).set("User-Agent", DEFAULT_UA).set("Referer", referer).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => return err(rq, code, "upstream refused"),
        Err(e) => return err(rq, 502, &format!("upstream failed: {e}")),
    };
    let ct = resp.content_type().to_string();
    let mut out = Vec::new();
    let _ = resp.into_reader().take(64 << 20).read_to_end(&mut out);
    let _ = rq.respond(
        Response::from_data(out)
            .with_header(hdr("Content-Type", &ct))
            .with_header(hdr("Cache-Control", "public, max-age=86400")),
    );
}
