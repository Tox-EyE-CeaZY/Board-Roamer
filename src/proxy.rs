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
    "furaffinity.net", // pages and pictures; see src/fa.rs for what is allowed and how fast
];
const DEFAULT_UA: &str = "BoardRoamer/0.1 (personal desktop viewer)";
const CACHE_TTL: Duration = Duration::from_secs(60);

/// The path and query of an http(s) URL ("/view/1/?a=b"), "/" if there is none.
fn path_of(url: &str) -> &str {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")).unwrap_or(url);
    rest.find(['/', '?', '#']).map(|i| if rest[i..].starts_with('/') { &rest[i..] } else { "/" }).unwrap_or("/")
}

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
    // Fur Affinity pages: one request a second, no burst (its robots.txt Crawl-delay)
    let strict = crate::fa::is_page_host(host);
    let gap = if strict {
        Duration::from_millis(crate::fa::GAP_MS)
    } else if host.ends_with("e621.net") || host.ends_with("e926.net") {
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
        if strict {
            tat.saturating_duration_since(now)
        } else {
            (tat.checked_sub(gap).unwrap_or(now)).saturating_duration_since(now)
        }
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

fn reply_h(rq: Request, code: u16, ctype: &str, body: Vec<u8>, extra: &[(&str, &str)]) {
    let mut r = Response::from_data(body).with_status_code(code).with_header(hdr("Content-Type", ctype)).with_header(hdr("Cache-Control", "no-store"));
    for (k, v) in extra {
        if v.bytes().all(|b| (32..127).contains(&b)) {
            r = r.with_header(hdr(k, v));
        }
    }
    let _ = rq.respond(r);
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
    // Fur Affinity: pages only (pictures go through /img), and only the pages its robots.txt does not close to automated clients
    let fa_page = crate::fa::is_page_host(&host);
    if crate::fa::is_fa(&host) && !fa_page {
        return err(rq, 403, "Fur Affinity pictures are fetched with /img");
    }
    if fa_page && !crate::fa::path_allowed(path_of(&target)) {
        let body = serde_json::json!({ "error": "Fur Affinity asks automated apps not to open that page, so it opens in your browser instead.", "robots": true });
        return reply(rq, 403, "application/json", body.to_string().into_bytes());
    }
    let method = rq.method().clone();
    if fa_page && method != Method::Get {
        return err(rq, 405, "Board Roamer only reads from Fur Affinity");
    }
    let ua = if fa_page {
        crate::fa::user_agent().unwrap_or_else(|| DEFAULT_UA.into()) // the sign-in window's own, which Cloudflare's clearance is tied to
    } else {
        header_val(&rq, "x-br-ua").filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_UA.into())
    };
    let auth = header_val(&rq, "x-br-auth").filter(|s| !s.is_empty());
    let cache_key = format!("{target}|{}|{}", auth.as_deref().unwrap_or(""), if fa_page { crate::fa::generation() } else { 0 });

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
    let mut req = agent.request(method.as_str(), &target).set("User-Agent", &ua).set("Accept", if fa_page { "text/html,application/xhtml+xml" } else { "application/json" });
    if let Some(a) = &auth {
        req = req.set("Authorization", a);
    }
    if fa_page {
        if let Some(c) = crate::fa::cookie_header() {
            req = req.set("Cookie", &c);
        }
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
    let mitigated = resp.header("cf-mitigated").map_or(false, |v| v.eq_ignore_ascii_case("challenge"));
    let final_url = resp.get_url().to_string();
    let mut out = Vec::new();
    let _ = resp.into_reader().take(32 << 20).read_to_end(&mut out);

    if fa_page {
        // Cloudflare's "checking your browser" page: say so, never try to get past it (the page shows a banner and waits)
        if crate::fa::is_challenge(code, mitigated, &out) {
            let body = serde_json::json!({ "error": "Fur Affinity needs a quick check in a browser window", "challenge": true });
            return reply_h(rq, 503, "application/json", body.to_string().into_bytes(), &[("X-BR-FA", "challenge")]);
        }
        let extra = [("X-BR-FA", "ok"), ("X-BR-Final", final_url.as_str())];
        if method == Method::Get && code == 200 {
            cache_put(cache_key, code, &ct, &out);
        }
        return reply_h(rq, code, &ct, out, &extra);
    }
    if method == Method::Get && code == 200 {
        cache_put(cache_key, code, &ct, &out);
    }
    reply(rq, code, &ct, out);
}

fn cache_put(key: String, code: u16, ct: &str, out: &[u8]) {
    let mut c = CACHE.get_or_init(Default::default).lock().unwrap();
    if c.len() > 300 {
        c.retain(|_, v| v.0.elapsed() < CACHE_TTL);
        if c.len() > 300 {
            c.clear();
        }
    }
    c.insert(key, (Instant::now(), code, ct.to_string(), out.to_vec()));
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
    let mut get = agent.get(&target).set("User-Agent", &ua);
    if crate::fa::is_fa(&host) {
        get = get.set("Referer", "https://www.furaffinity.net/"); // its picture hosts check where the request came from
    }
    let resp = match get.call() {
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
    let referer = if crate::fa::is_fa(&host) {
        "https://www.furaffinity.net/"
    } else if host.ends_with("e621.net") || host.ends_with("e926.net") {
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
    // one shared agent: pictures reuse connections instead of a new TLS handshake each
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    let agent = AGENT.get_or_init(|| ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(8)).timeout_read(Duration::from_secs(20)).max_idle_connections_per_host(16).build());
    // Fur Affinity's picture host sheds load when a page asks for dozens at once: at most 4 at a time, and a refused or
    // dropped one is asked for again after a pause (it used to show as a picture that "did not load")
    // a slow picture must not make the rest wait: the small pictures (t.) and the originals (d.) have places of their own, and a place
    // is only held until the site has answered, not while the picture itself downloads
    let fa = crate::fa::is_fa(&host);
    let slot = fa.then(|| fa_slot(host.starts_with("t.")));
    let mut tries = 0;
    let resp = loop {
        match agent.get(&target).set("User-Agent", DEFAULT_UA).set("Referer", referer).call() {
            Ok(r) => break r,
            Err(ureq::Error::Status(code, r)) => {
                if fa && tries < 3 && (code == 429 || code >= 500) {
                    let wait = r.header("Retry-After").and_then(|v| v.parse::<u64>().ok()).unwrap_or(1).clamp(1, 5);
                    tries += 1;
                    std::thread::sleep(Duration::from_secs(wait * tries));
                    continue;
                }
                return err(rq, code, "upstream refused");
            }
            Err(e) => {
                if fa && tries < 3 {
                    tries += 1;
                    std::thread::sleep(Duration::from_millis(600 * tries));
                    continue;
                }
                return err(rq, 502, &format!("upstream failed: {e}"));
            }
        }
    };
    drop(slot);
    // streamed: the browser starts receiving while the picture is still arriving, instead of waiting for all of it
    let ct = resp.content_type().to_string();
    let len = resp.header("Content-Length").and_then(|v| v.parse::<usize>().ok()).filter(|n| *n <= 64 << 20);
    let reader = resp.into_reader().take(64 << 20);
    let _ = rq.respond(Response::new(tiny_http::StatusCode(200), vec![hdr("Content-Type", &ct), hdr("Cache-Control", "public, max-age=86400")], reader, len, None));
}

/// Holds one of a few places for asking Fur Affinity's picture hosts (4 for thumbnails, 2 for originals); freed when dropped.
struct FaSlot(usize);
static FA_BUSY: (std::sync::Mutex<[u32; 2]>, std::sync::Condvar) = (std::sync::Mutex::new([0, 0]), std::sync::Condvar::new());
fn fa_slot(small: bool) -> FaSlot {
    let (k, max) = if small { (0, 4) } else { (1, 2) };
    let mut n = FA_BUSY.0.lock().unwrap_or_else(|e| e.into_inner());
    while n[k] >= max {
        n = FA_BUSY.1.wait(n).unwrap_or_else(|e| e.into_inner());
    }
    n[k] += 1;
    FaSlot(k)
}
impl Drop for FaSlot {
    fn drop(&mut self) {
        FA_BUSY.0.lock().unwrap_or_else(|e| e.into_inner())[self.0] -= 1;
        FA_BUSY.1.notify_all();
    }
}
