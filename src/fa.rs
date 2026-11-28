//! Fur Affinity, the Rust side: what the proxy may ask the site for, the signed-in session, and the small /fa/* API the page uses.
//!
//! Rules this file enforces for every request the app makes to furaffinity.net (from FA's robots.txt, read 2026-11-27):
//!  * at least one second between page requests (`GAP_MS`), no bursts;
//!  * only pages that robots.txt does not disallow for automated clients (`path_allowed`): search, the notification and
//!    watch pages, fav/unfav, notes, settings and the rest are never requested. The app opens those in the user's browser.
//!
//! The session (cookies `a` and `b`, and Cloudflare's `cf_clearance`) lives only in `fa.json` in the app's data folder.
//! The page script never sees the values: it only learns whether they exist (`/fa/status`). They are never logged and
//! never part of sync.

use percent_encoding::percent_decode_str;
use std::{
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};
use tiny_http::{Header, Method, Request, Response};

const SITE: &str = "furaffinity.net";
/// robots.txt `Crawl-delay: 1`.
pub const GAP_MS: u64 = 1000;

/// furaffinity.net and its picture hosts (t., d., a.).
pub fn is_fa(host: &str) -> bool {
    host == SITE || host.ends_with(".furaffinity.net")
}

/// The host that serves pages (as opposed to pictures): throttled, and the only one that gets the session cookies.
pub fn is_page_host(host: &str) -> bool {
    host == SITE || host == "www.furaffinity.net"
}

/// An allow-list of the read-only pages the app shows: the front page, browse, a submission, a user, and a user's
/// gallery, scraps, favorites and journals. Everything else (even if robots.txt would let it through) stays closed.
pub fn path_allowed(path: &str) -> bool {
    let raw = path.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_decode_str(raw).decode_utf8_lossy().to_ascii_lowercase();
    if decoded.contains("..") || decoded.contains('\\') {
        return false;
    }
    let seg: Vec<&str> = decoded.split('/').filter(|s| !s.is_empty()).collect();
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match seg.as_slice() {
        [] => true,
        ["browse", ..] => seg.len() <= 4,
        ["view", id] => digits(id),
        ["user", name] => *name != "history",
        ["gallery", _] | ["gallery", _, _] | ["scraps", _] | ["scraps", _, _] => true,
        ["gallery", _, "folder", id] | ["gallery", _, "folder", id, _] | ["gallery", _, "folder", id, _, _] => digits(id),
        ["favorites", ..] => seg.len() >= 2 && seg.len() <= 4,
        ["journals", _] | ["journals", _, _] | ["journal", _] => true,
        _ => false,
    }
}

/// Is this answer Cloudflare's "checking your browser" page rather than the site? Never tries to get past it.
pub fn is_challenge(code: u16, mitigated: bool, body: &[u8]) -> bool {
    if mitigated {
        return true;
    }
    let head = String::from_utf8_lossy(&body[..body.len().min(6000)]).to_ascii_lowercase();
    if head.contains("<title>just a moment") || head.contains("cf-browser-verification") || head.contains("challenge-platform") {
        return true;
    }
    matches!(code, 403 | 503) && (head.contains("cf-chl") || head.contains("attention required"))
}

/* ------------------------------------------------------------------ the session */
#[derive(Default, Clone)]
struct Creds {
    a: String,
    b: String,
    clearance: String,
    ua: String,
}

static DIR: OnceLock<PathBuf> = OnceLock::new();
static CREDS: OnceLock<Mutex<Creds>> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn creds() -> &'static Mutex<Creds> {
    CREDS.get_or_init(Default::default)
}

fn file() -> Option<PathBuf> {
    DIR.get().map(|d| d.join("fa.json"))
}

pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
    let v: serde_json::Value = file().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
    *creds().lock().unwrap() = Creds { a: s("a"), b: s("b"), clearance: s("clearance"), ua: s("ua") };
}

fn save(c: &Creds) {
    GENERATION.fetch_add(1, Ordering::Relaxed);
    if let Some(f) = file() {
        let body = serde_json::json!({ "a": c.a, "b": c.b, "clearance": c.clearance, "ua": c.ua });
        let _ = std::fs::write(f, body.to_string());
    }
}

/// Changes whenever the session does, so a cached page from another account is never served.
pub fn generation() -> u64 {
    GENERATION.load(Ordering::Relaxed)
}

/// A cookie value we are willing to put in a header: nothing that could end the header or add another one.
fn sane(v: &str) -> bool {
    !v.is_empty() && v.len() < 512 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.%+=/~:".contains(&b))
}

/// `Cookie` header for page requests, if there is a session.
pub fn cookie_header() -> Option<String> {
    let c = creds().lock().unwrap();
    let mut parts = Vec::new();
    if sane(&c.a) && sane(&c.b) {
        parts.push(format!("a={}", c.a));
        parts.push(format!("b={}", c.b));
    }
    if sane(&c.clearance) {
        parts.push(format!("cf_clearance={}", c.clearance));
    }
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// The User-Agent the sign-in window used. Cloudflare ties its clearance to it, so page requests send the same one.
pub fn user_agent() -> Option<String> {
    let c = creds().lock().unwrap();
    (!c.ua.is_empty() && c.ua.len() < 400 && !c.ua.bytes().any(|b| b < 32)).then(|| c.ua.clone())
}

/// What the sign-in window found. Only keeps what it was given; returns true when something changed.
pub fn set_from_window(a: Option<&str>, b: Option<&str>, clearance: Option<&str>, ua: Option<&str>) -> bool {
    let mut c = creds().lock().unwrap();
    let before = (c.a.clone(), c.b.clone(), c.clearance.clone(), c.ua.clone());
    if let (Some(a), Some(b)) = (a, b) {
        if sane(a) && sane(b) {
            c.a = a.into();
            c.b = b.into();
        }
    }
    if let Some(v) = clearance.filter(|v| sane(v)) {
        c.clearance = v.into();
    }
    if let Some(u) = ua.filter(|u| !u.is_empty()) {
        c.ua = u.chars().take(400).collect();
    }
    let changed = before != (c.a.clone(), c.b.clone(), c.clearance.clone(), c.ua.clone());
    if changed {
        let snap = c.clone();
        drop(c);
        save(&snap);
    }
    changed
}

pub fn connected() -> bool {
    let c = creds().lock().unwrap();
    sane(&c.a) && sane(&c.b)
}

pub fn clear() {
    let mut c = creds().lock().unwrap();
    *c = Creds::default();
    let snap = c.clone();
    drop(c);
    save(&snap);
}

/* ------------------------------------------------------------------ the page's own API (/fa/...) */
fn json(rq: Request, code: u16, v: serde_json::Value) {
    let _ = rq.respond(
        Response::from_string(v.to_string())
            .with_status_code(code)
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
            .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap()),
    );
}

pub fn status() -> serde_json::Value {
    let c = creds().lock().unwrap();
    serde_json::json!({ "connected": sane(&c.a) && sane(&c.b), "cleared": sane(&c.clearance), "ua": !c.ua.is_empty() })
}

/// GET /fa/status                 -> {connected, cleared, ua}   (no values, ever)
/// POST /fa/login | /fa/verify    -> opens FA's own page in a window where the user signs in / passes the check
/// POST /fa/paste {a, b}          -> the manual way: two cookie values copied from a browser
/// POST /fa/disconnect            -> forget the session and close the window
pub fn request(mut rq: Request, path: &str) {
    match (path, rq.method().clone()) {
        ("/fa/status", _) => json(rq, 200, status()),
        ("/fa/login", Method::Post) => {
            crate::appcfg::send_event("fa:login".into());
            json(rq, 200, serde_json::json!({ "ok": true }))
        }
        ("/fa/verify", Method::Post) => {
            crate::appcfg::send_event("fa:verify".into());
            json(rq, 200, serde_json::json!({ "ok": true }))
        }
        ("/fa/paste", Method::Post) => {
            let mut body = String::new();
            let _ = rq.as_reader().take(4096).read_to_string(&mut body);
            let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            let (a, b) = (v["a"].as_str().unwrap_or("").trim(), v["b"].as_str().unwrap_or("").trim());
            if !(sane(a) && sane(b)) {
                return json(rq, 400, serde_json::json!({ "error": "Those do not look like the two cookie values (a and b)." }));
            }
            set_from_window(Some(a), Some(b), None, None);
            json(rq, 200, status())
        }
        ("/fa/disconnect", Method::Post) => {
            clear();
            crate::appcfg::send_event("fa:close".into());
            json(rq, 200, status())
        }
        _ => json(rq, 404, serde_json::json!({ "error": "not found" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts() {
        assert!(is_fa("furaffinity.net") && is_fa("t.furaffinity.net") && is_fa("d.furaffinity.net"));
        assert!(!is_fa("notfuraffinity.net") && !is_fa("furaffinity.net.evil.com"));
        assert!(is_page_host("www.furaffinity.net") && !is_page_host("d.furaffinity.net"));
    }

    #[test]
    fn robots_paths() {
        for ok in ["/", "/browse/", "/browse/2/", "/view/123456/", "/view/123456", "/user/some_name/", "/user/name", "/gallery/name/", "/gallery/name/2/", "/gallery/name/folder/55/slug", "/gallery/name/folder/55/slug/2", "/scraps/name/", "/favorites/name/", "/favorites/name/123/next", "/journals/name/", "/journal/99/", "/view/123/?upload-sort=asc"] {
            assert!(path_allowed(ok), "{ok} should be allowed");
        }
        for no in [
            "/search/", "/search/?q=cat", "/SEARCH/", "/%73earch/", "/msg/submissions/", "/msg/pms/", "/controls/settings/", "/fav/1/?key=x", "/unfav/1/", "/watch/name/", "/unwatch/name/",
            "/block/name/", "/newpm/name/", "/login/", "/logout/", "/submit/", "/replyto/1", "/me", "/avatar/x", "/stats/x", "/online", "/externalurl", "/captcha", "/plus", "/user/history/", "/view/123/edit",
            "/view/abc/", "/gallery/name/folder/xx/slug", "/full/123/", "/commissions/name/", "/watchlist/to/name/", "/gallery/../msg/", "/help/",
        ] {
            assert!(!path_allowed(no), "{no} must be refused");
        }
    }

    #[test]
    fn challenge() {
        assert!(is_challenge(403, true, b""));
        assert!(is_challenge(403, false, b"<html><head><title>Just a moment...</title>"));
        assert!(is_challenge(200, false, b"<title>Just a moment...</title>"));
        assert!(is_challenge(503, false, b"... cf-chl-opt ..."));
        assert!(!is_challenge(200, false, b"<body id=\"pageid-frontpage\">"));
        assert!(!is_challenge(404, false, b"not found"));
    }

    #[test]
    fn cookie_values_are_checked() {
        assert!(sane("1a2b3c4d-5e6f-7a8b") && sane("abc.def_ghi-1.2"));
        assert!(!sane("") && !sane("a; b=c") && !sane("a\r\nX: y") && !sane("a b") && !sane(&"x".repeat(600)));
    }
}
