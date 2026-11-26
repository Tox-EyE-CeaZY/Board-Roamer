//! Library sync hub. The desktop app keeps one merged copy of the library (boards, follows, trail, settings) on disk.
//! Every device -- this app's own window included -- pulls it, merges its own changes in the browser, and pushes the result
//! back with a revision check. The merging itself lives in ui/js/syncmerge.js; this side is a small, dumb, safe store.
//!
//! The loopback server (the app's own window) can always reach /sync/*. Other devices reach it only while "Share" is on,
//! through a second listener on the network. That listener speaks HTTPS with a self-signed certificate this computer makes once;
//! a phone learns the certificate's fingerprint from the QR code it scans and pins it, so only this computer is ever trusted.
//!
//! Pairing: the computer shows a QR code holding its id, addresses, certificate fingerprint and a one-time pairing key. The phone
//! never sends the key; it sends an HMAC over a nonce and the fingerprint it saw, and the computer answers with its own HMAC plus
//! a long device token. Every later request carries that token. Any number of computers can sit on one network: each has its own
//! id, certificate and tokens, and a phone only talks to the one it paired with (see src/discover.rs for how it is found).

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tiny_http::{Header, Method, Request, Response, Server, SslConfig};

const FIRST_PORT: u16 = 4622;
const MAX_BODY: u64 = 64 * 1024 * 1024;
const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const OFFER_SECS: u64 = 600;
const SERVICE: &str = "_boardroamer._tcp.local.";

/// A device that has talked to this hub. Phones also say where their own folder server listens (if they share).
#[derive(Default, Clone)]
struct Dev {
    last: u64,
    addr: Option<String>,
    port: u16,
    share: bool,
}

/// A phone (or other device) that has been paired. The token is what it sends with every request.
#[derive(Clone)]
struct Paired {
    id: String,
    name: String,
    token: String,
    created: u64,
}

/// The pairing key shown in the QR code. Valid for a few minutes and for ONE device.
struct Offer {
    key: String,
    until: Instant,
    fails: u8,
}

struct State {
    dir: PathBuf,
    enabled: bool,
    /// Random id of this computer: what a phone remembers it by, and what it looks for on the network.
    id: String,
    /// The name the person gave this computer (shown on phones that find it).
    name: String,
    cert_pem: Vec<u8>,
    key_pem: Vec<u8>,
    fp: String,
    paired: Vec<Paired>,
    offer: Option<Offer>,
    mdns: Option<mdns_sd::ServiceDaemon>,
    port: u16,
    rev: u64,
    server: Option<Arc<Server>>,
    devices: HashMap<String, Dev>,
    fails: Vec<Instant>,
    /// The desktop's logins, held in memory only, for ONE new device to collect when it first connects.
    creds: Option<Vec<u8>>,
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

/// Random bytes from the operating system.
fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("the system has no random numbers");
    b
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A pairing key people can type if the camera will not scan: 16 letters and digits (80 bits), without look-alikes.
fn random_key() -> String {
    let mut out = String::new();
    for (i, b) in rand_bytes::<16>().iter().enumerate() {
        if i > 0 && i % 4 == 0 {
            out.push('-');
        }
        out.push(ALPHABET[(*b as usize) % ALPHABET.len()] as char); // 256 is a multiple of 32: no bias
    }
    out
}

fn norm(code: &str) -> String {
    code.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// HMAC-SHA256 as hex. The pairing key is the secret; the parts say what is being vouched for.
fn mac(key: &str, parts: &[&str]) -> String {
    hmac_hex(norm(key).as_bytes(), parts.join("|").as_bytes())
}

fn hmac_hex(key: &[u8], msg: &[u8]) -> String {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("hmac takes any key length");
    m.update(msg);
    hex(&m.finalize().into_bytes())
}

/// What the computer shows a phone's folder server (and the phone expects): HMAC-SHA256(device token, "share"), in hex.
fn share_code(token: &str) -> String {
    hmac_hex(token.as_bytes(), b"share")
}

fn computer_name() -> String {
    crate::os::computer_name()
}

fn doc_path(s: &State) -> PathBuf {
    s.dir.join("sync-doc.json")
}


fn save_config(s: &State) {
    let devices: Vec<_> = s.paired.iter().map(|d| serde_json::json!({ "id": d.id, "name": d.name, "token": d.token, "created": d.created })).collect();
    let v = serde_json::json!({ "enabled": s.enabled, "rev": s.rev, "port": s.port, "id": s.id, "name": s.name, "devices": devices });
    let _ = fs::write(s.dir.join("sync-config.json"), v.to_string());
}

/// This computer's certificate: made once, kept next to the library. Its SHA-256 fingerprint is what phones pin.
fn load_identity(dir: &std::path::Path) -> (Vec<u8>, Vec<u8>, String) {
    let (cp, kp) = (dir.join("sync-cert.pem"), dir.join("sync-key.pem"));
    if let (Ok(c), Ok(k)) = (fs::read(&cp), fs::read(&kp)) {
        if let Some(fp) = fingerprint(&c) {
            return (c, k, fp);
        }
    }
    let ck = rcgen::generate_simple_self_signed(vec!["board-roamer.local".to_string(), "localhost".to_string()]).expect("could not make a certificate");
    let (c, k) = (ck.cert.pem().into_bytes(), ck.signing_key.serialize_pem().into_bytes());
    let _ = fs::write(&cp, &c);
    let _ = fs::write(&kp, &k);
    let fp = fingerprint(&c).unwrap_or_default();
    (c, k, fp)
}

/// SHA-256 over the certificate's DER bytes, as lowercase hex.
fn fingerprint(pem: &[u8]) -> Option<String> {
    use base64::Engine;
    let text = String::from_utf8_lossy(pem);
    let body: String = text.lines().skip_while(|l| !l.starts_with("-----BEGIN CERTIFICATE")).skip(1).take_while(|l| !l.starts_with("-----END")).collect();
    let der = base64::engine::general_purpose::STANDARD.decode(body.trim()).ok()?;
    Some(hex(&Sha256::digest(der)))
}

pub fn init(dir: PathBuf) {
    let cfg: serde_json::Value = fs::read(dir.join("sync-config.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let (cert_pem, key_pem, fp) = load_identity(&dir);
    let paired = cfg["devices"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|d| Some(Paired { id: d["id"].as_str()?.into(), name: d["name"].as_str()?.into(), token: d["token"].as_str()?.into(), created: d["created"].as_u64().unwrap_or(0) }))
                .collect()
        })
        .unwrap_or_default();
    let state = State {
        dir,
        enabled: cfg["enabled"].as_bool().unwrap_or(false),
        id: cfg["id"].as_str().filter(|t| t.len() == 16).map(String::from).unwrap_or_else(|| hex(&rand_bytes::<8>())),
        name: cfg["name"].as_str().map(String::from).filter(|t| !t.trim().is_empty()).unwrap_or_else(computer_name),
        cert_pem,
        key_pem,
        fp,
        paired,
        offer: None,
        mdns: None,
        port: cfg["port"].as_u64().unwrap_or(FIRST_PORT as u64) as u16,
        rev: cfg["rev"].as_u64().unwrap_or(0),
        server: None,
        devices: HashMap::new(),
        fails: Vec::new(),
        creds: None,
    };
    save_config(&state);
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
        let ssl = SslConfig { certificate: s.cert_pem.clone(), private_key: s.key_pem.clone() };
        if let Ok(srv) = Server::https(("0.0.0.0", p), ssl) {
            bound = Some((srv, p));
            break;
        }
    }
    let Some((srv, port)) = bound else { return Err("could not open a network port".into()) };
    let srv = Arc::new(srv);
    s.port = port;
    s.server = Some(srv.clone());
    save_config(&s);
    advertise(&mut s);
    drop(s);
    thread::spawn(move || {
        for rq in srv.incoming_requests() {
            thread::spawn(move || net_request(rq));
        }
    });
    Ok(port)
}

fn stop_listener() {
    let mut s = st();
    let srv = s.server.take();
    unadvertise(&mut s);
    drop(s);
    if let Some(s) = srv {
        s.unblock();
    }
}

/// Tell the local network that this computer shares a library: a `_boardroamer._tcp` service whose text carries the id and the name.
/// The host name is `<id>.local`, so the computer also has a name of its own that no roommate's computer shares.
fn advertise(s: &mut State) {
    unadvertise(s);
    let Ok(d) = mdns_sd::ServiceDaemon::new() else { return };
    let host = format!("br-{}.local.", &s.id[..8]);
    let props = [("id", s.id.as_str()), ("name", s.name.as_str()), ("fp", &s.fp[..16]), ("v", "1")];
    if let Ok(info) = mdns_sd::ServiceInfo::new(SERVICE, &format!("br-{}", s.id), &host, "", s.port, &props[..]) {
        let _ = d.register(info.enable_addr_auto());
    }
    s.mdns = Some(d);
}

fn unadvertise(s: &mut State) {
    if let Some(d) = s.mdns.take() {
        let _ = d.shutdown();
    }
}

/// The text a phone gets from the QR code (and what "copy pairing link" copies).
fn pairing_link(s: &State, key: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let addrs: Vec<String> = crate::os::addresses().into_iter().map(|(ip, _)| format!("{ip}:{}", s.port)).collect();
    format!("boardroamer://pair?v=1&id={}&n={}&k={}&fp={}&a={}", s.id, utf8_percent_encode(&s.name, NON_ALPHANUMERIC), norm(key), s.fp, addrs.join(","))
}

/* ------------------------------------------------------------------ requests */

fn net_request(rq: Request) {
    let url = rq.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();
    if path == "/ping" {
        return reply(rq, 200, "text/plain", b"board-roamer-sync".to_vec(), None);
    }
    let local = matches!(path.as_str(), "/local/list" | "/local/file" | "/local/thumb");
    if !local && !matches!(path.as_str(), "/sync/doc" | "/sync/info" | "/sync/creds" | "/sync/device" | "/sync/devices" | "/sync/pair") {
        return json(rq, 404, serde_json::json!({ "error": "not found" }), None);
    }
    {
        let mut s = st();
        let cut = Instant::now() - Duration::from_secs(60);
        s.fails.retain(|t| *t > cut);
        if s.fails.len() >= 8 {
            drop(s);
            return json(rq, 429, serde_json::json!({ "error": "too many wrong attempts, wait a minute" }), None);
        }
    }
    if path == "/sync/pair" {
        return pair_request(rq);
    }
    let given = header_val(&rq, "authorization").and_then(|v| v.strip_prefix("Bearer ").map(String::from)).unwrap_or_default();
    let who = {
        let s = st();
        // every token is compared, so the time taken does not say which one was close
        let mut found = None;
        for d in &s.paired {
            if same(&given, &d.token) {
                found = Some(d.name.clone());
            }
        }
        if s.enabled { found } else { None }
    };
    let Some(name) = who else {
        st().fails.push(Instant::now());
        thread::sleep(Duration::from_millis(350));
        return json(rq, 401, serde_json::json!({ "error": "this device is not paired (any more) with that computer" }), None);
    };
    st().devices.entry(name.clone()).or_default().last = now_secs();
    if path == "/sync/creds" {
        return creds_claim(rq);
    }
    if path == "/sync/device" {
        return device_announce(rq, name);
    }
    if path == "/sync/devices" {
        return device_list(rq);
    }
    if local {
        if !crate::local::sharing() {
            return json(rq, 403, serde_json::json!({ "error": "this computer is not sharing its folders" }), None);
        }
        let query = url.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();
        return crate::local::serve(rq, &path, &query);
    }
    doc_request(rq, &path);
}

/// A phone proves it knows the pairing key without sending it, and gets a device token back, with proof that this is the computer
/// that made the key. Both proofs cover the certificate fingerprint, so someone sitting in the middle fails one of them.
fn pair_request(mut rq: Request) {
    if rq.method() != &Method::Post {
        return json(rq, 405, serde_json::json!({ "error": "method not allowed" }), None);
    }
    let mut body = String::new();
    let _ = rq.as_reader().take(2048).read_to_string(&mut body);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let nonce: String = v["nonce"].as_str().unwrap_or("").chars().filter(|c| c.is_ascii_hexdigit()).take(64).collect();
    let proof = v["proof"].as_str().unwrap_or("").to_string();
    let device: String = v["device"].as_str().unwrap_or("a phone").chars().filter(|c| !c.is_control()).take(40).collect();
    let mut s = st();
    let live = matches!(&s.offer, Some(o) if o.until > Instant::now());
    if !live || nonce.len() < 16 {
        s.fails.push(Instant::now());
        drop(s);
        return json(rq, 403, serde_json::json!({ "error": "no pairing is open on that computer. Choose Add a phone there and scan the new code" }), None);
    }
    let key = s.offer.as_ref().map(|o| o.key.clone()).unwrap_or_default();
    if !same(&mac(&key, &["pair-c", &nonce, &s.fp]), &proof) {
        s.fails.push(Instant::now());
        if let Some(o) = s.offer.as_mut() {
            o.fails += 1;
            if o.fails >= 5 {
                s.offer = None; // too many wrong guesses: the key is burnt
            }
        }
        drop(s);
        thread::sleep(Duration::from_millis(350));
        return json(rq, 403, serde_json::json!({ "error": "the pairing code did not match" }), None);
    }
    s.offer = None;
    let token = hex(&rand_bytes::<32>());
    let id = hex(&rand_bytes::<8>());
    let mut name = if device.trim().is_empty() { "a phone".to_string() } else { device };
    let base = name.clone();
    let mut n = 2;
    while s.paired.iter().any(|d| d.name == name) {
        name = format!("{base} {n}");
        n += 1;
    }
    s.paired.push(Paired { id: id.clone(), name: name.clone(), token: token.clone(), created: now_secs() });
    save_config(&s);
    let answer = serde_json::json!({
        "id": id, "token": token, "hostId": s.id, "host": s.name, "name": name, "port": s.port,
        "addrs": addresses(), "proof": mac(&key, &["pair-h", &nonce, &s.fp, &token]),
    });
    drop(s);
    json(rq, 200, answer, None);
}

/// A phone says where its own folder server listens, and whether it shares.
fn device_announce(mut rq: Request, name: String) {
    let ip = rq.remote_addr().map(|a| a.ip().to_string());
    let mut body = String::new();
    let _ = rq.as_reader().take(1024).read_to_string(&mut body);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    {
        let mut s = st();
        let d = s.devices.entry(name).or_default();
        d.addr = ip;
        d.port = v["port"].as_u64().unwrap_or(0) as u16;
        d.share = v["share"].as_bool().unwrap_or(false) && d.port > 0;
    }
    json(rq, 200, serde_json::json!({ "ok": true }), None);
}

/// Everyone who shares folders, for a phone that wants to browse them. The computer itself is listed as `hostShare`.
fn device_list(rq: Request) {
    let s = st();
    let devices: Vec<_> = s.devices.iter().filter(|(_, d)| d.share && d.addr.is_some()).filter_map(|(n, d)| {
            let token = &s.paired.iter().find(|p| &p.name == n)?.token;
            Some(serde_json::json!({ "name": n, "addr": d.addr, "port": d.port, "code": share_code(token) }))
        })
        .collect();
    let v = serde_json::json!({ "host": s.name, "hostShare": crate::local::sharing(), "devices": devices });
    drop(s);
    json(rq, 200, v, None);
}

/// Where to reach a sharing device by name (for the computer's own window), and the token that device was given when it paired.
pub fn device_target(name: &str) -> Option<(String, String)> {
    let s = st();
    let d = s.devices.get(name)?;
    if !(d.share && d.port > 0) {
        return None;
    }
    // a phone's folder server is plain HTTP on the home network, so it is never given the device token itself, only a code derived from it
    let token = share_code(&s.paired.iter().find(|p| p.name == name)?.token);
    Some((format!("http://{}:{}", d.addr.clone()?, d.port), token))
}

/// A new device asks for the logins. They are handed over once, then forgotten.
fn creds_claim(rq: Request) {
    if rq.method() != &Method::Get {
        return json(rq, 405, serde_json::json!({ "error": "method not allowed" }), None);
    }
    let taken = st().creds.take();
    match taken {
        Some(b) => reply(rq, 200, "application/json", b, None),
        None => reply(rq, 204, "application/json", Vec::new(), None),
    }
}

/// The desktop's own window arms (PUT) or disarms (DELETE) the one-time login handoff.
fn creds_arm(mut rq: Request) {
    match rq.method() {
        Method::Put | Method::Post => {
            let mut body = Vec::new();
            let _ = rq.as_reader().take(64 * 1024).read_to_end(&mut body);
            let ok = serde_json::from_slice::<serde_json::Value>(&body).map(|v| v.is_object() && v.as_object().map_or(false, |o| !o.is_empty())).unwrap_or(false);
            st().creds = if ok { Some(body) } else { None };
            json(rq, 200, serde_json::json!({ "armed": ok }), None);
        }
        Method::Delete => {
            st().creds = None;
            json(rq, 200, serde_json::json!({ "armed": false }), None);
        }
        _ => json(rq, 405, serde_json::json!({ "error": "method not allowed" }), None),
    }
}

/// Routes shared by the loopback server (the app's own window) and the network listener.
pub fn local_request(rq: Request, path: &str) {
    match path {
        "/sync/doc" | "/sync/info" => doc_request(rq, path),
        "/sync/creds" => creds_arm(rq),
        "/sync/config" => config_request(rq),
        "/sync/qr" => qr_request(rq),
        _ => json(rq, 404, serde_json::json!({ "error": "not found" }), None),
    }
}

fn doc_request(mut rq: Request, path: &str) {
    if path == "/sync/info" {
        let s = st();
        let bytes = fs::metadata(doc_path(&s)).map(|m| m.len()).unwrap_or(0);
        let v = serde_json::json!({ "app": "board-roamer-sync", "rev": s.rev, "host": s.name, "id": s.id, "port": s.port, "addrs": addresses(), "bytes": bytes });
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
        if let Some(n) = v["name"].as_str() {
            let n: String = n.chars().filter(|c| !c.is_control()).take(40).collect();
            let mut s = st();
            s.name = if n.trim().is_empty() { computer_name() } else { n.trim().to_string() };
            save_config(&s);
            if s.server.is_some() {
                advertise(&mut s);
            }
        }
        if v["pair"].as_bool() == Some(true) {
            let mut s = st();
            if s.enabled {
                s.offer = Some(Offer { key: random_key(), until: Instant::now() + Duration::from_secs(OFFER_SECS), fails: 0 });
            }
        }
        if v["cancelPair"].as_bool() == Some(true) {
            st().offer = None;
        }
        if let Some(id) = v["revoke"].as_str() {
            let mut s = st();
            if let Some(i) = s.paired.iter().position(|d| d.id == id) {
                let gone = s.paired.remove(i);
                s.devices.remove(&gone.name);
            }
            save_config(&s);
        }
        if v["revokeAll"].as_bool() == Some(true) {
            let mut s = st();
            s.paired.clear();
            s.devices.clear();
            s.creds = None; // a new pairing must arm the login again on purpose
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
                s.offer = None;
                s.devices.clear();
                s.creds = None;
                save_config(&s);
            }
        }
    }
    let s = st();
    let now = now_secs();
    let devices: Vec<_> = s
        .paired
        .iter()
        .map(|p| {
            let d = s.devices.get(&p.name);
            serde_json::json!({ "id": p.id, "name": p.name, "ago": d.map(|d| now.saturating_sub(d.last)), "share": d.map_or(false, |d| d.share) })
        })
        .collect();
    let offer = s.offer.as_ref().filter(|o| o.until > Instant::now()).map(|o| {
        serde_json::json!({ "key": o.key, "expiresIn": o.until.saturating_duration_since(Instant::now()).as_secs(), "link": pairing_link(&s, &o.key) })
    });
    let addrs = addresses();
    let tailscale = addrs.iter().any(|a| a["kind"] == "tailscale");
    let v = serde_json::json!({
        "enabled": s.enabled, "port": s.port, "host": s.name, "computer": computer_name(), "id": s.id, "fp": s.fp,
        "rev": s.rev, "addrs": addrs, "tailscale": tailscale, "devices": devices, "credsArmed": s.creds.is_some(), "offer": offer,
    });
    drop(s);
    json(rq, 200, v, None);
}

/// The QR code for the open pairing offer, as an SVG (the app's own window shows it).
fn qr_request(rq: Request) {
    let link = {
        let s = st();
        s.offer.as_ref().filter(|o| o.until > Instant::now()).map(|o| pairing_link(&s, &o.key))
    };
    let Some(link) = link else { return json(rq, 404, serde_json::json!({ "error": "no pairing is open" }), None) };
    match qrcode::QrCode::with_error_correction_level(link.as_bytes(), qrcode::EcLevel::L) {
        Ok(code) => {
            let svg = code.render::<qrcode::render::svg::Color>().min_dimensions(260, 260).quiet_zone(true).dark_color(qrcode::render::svg::Color("#000000")).light_color(qrcode::render::svg::Color("#ffffff")).build();
            reply(rq, 200, "image/svg+xml", svg.into_bytes(), None);
        }
        Err(_) => json(rq, 500, serde_json::json!({ "error": "could not make the code" }), None),
    }
}

/* ------------------------------------------------------------------ this computer's addresses */

fn addresses() -> Vec<serde_json::Value> {
    crate::os::addresses().into_iter().map(|(ip, kind)| serde_json::json!({ "ip": ip, "kind": kind })).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn curl(args: &[&str]) -> Option<(String, String)> {
        let o = std::process::Command::new("curl").args(["-sk", "--max-time", "10"]).args(args).output().ok()?;
        let all = String::from_utf8_lossy(&o.stdout).to_string();
        let (body, code) = all.rsplit_once("\n#")?;
        Some((body.to_string(), code.to_string()))
    }

    #[test]
    fn pairing_over_https() {
        let dir = std::env::temp_dir().join(format!("br-sync-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        init(dir.clone());
        // the certificate fingerprint is a SHA-256 of the DER
        let fp = st().fp.clone();
        assert_eq!(fp.len(), 64);
        // turn sharing on and open a pairing, the way the settings screen does
        {
            let mut s = st();
            s.enabled = true;
        }
        let port = start_listener().expect("listener");
        let base = format!("https://127.0.0.1:{port}");
        if curl(&["-w", "\n#%{http_code}", &format!("{base}/ping")]).map_or(true, |(_, c)| c != "200") {
            eprintln!("skipping: curl is not available or could not reach the listener");
            return;
        }
        // 1. no pairing open: refused
        let (_, c) = curl(&["-w", "\n#%{http_code}", "-X", "POST", "-d", "{\"nonce\":\"00112233445566778899aabbccddeeff\",\"proof\":\"x\"}", &format!("{base}/sync/pair")]).unwrap();
        assert_eq!(c, "403");
        // 2. open one
        let key = random_key();
        st().offer = Some(Offer { key: key.clone(), until: Instant::now() + Duration::from_secs(60), fails: 0 });
        let nonce = "00112233445566778899aabbccddeeff";
        // 3. a wrong proof (as if the fingerprint seen was somebody else's) is refused
        let bad = mac(&key, &["pair-c", nonce, &"0".repeat(64)]);
        let post = |proof: &str| curl(&["-w", "\n#%{http_code}", "-X", "POST", "-d", &format!("{{\"nonce\":\"{nonce}\",\"proof\":\"{proof}\",\"device\":\"Test phone\"}}"), &format!("{base}/sync/pair")]).unwrap();
        assert_eq!(post(&bad).1, "403");
        // 4. the right proof pairs, and the answer proves the computer knew the key
        let good = mac(&key, &["pair-c", nonce, &fp]);
        let (body, c) = post(&good);
        assert_eq!(c, "200", "{body}");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        let token = v["token"].as_str().unwrap().to_string();
        assert_eq!(v["proof"].as_str().unwrap(), mac(&key, &["pair-h", nonce, &fp, &token]));
        // 5. the key works once
        assert_eq!(post(&good).1, "403");
        // 6. the token opens /sync/info, a wrong one does not
        let get = |t: &str| curl(&["-w", "\n#%{http_code}", "-H", &format!("Authorization: Bearer {t}"), &format!("{base}/sync/info")]).unwrap();
        let (body, c) = get(&token);
        assert_eq!(c, "200", "{body}");
        assert_eq!(get(&"0".repeat(64)).1, "401");
        // 7. revoking closes it again
        let id = v["id"].as_str().unwrap().to_string();
        st().paired.retain(|d| d.id != id);
        assert_eq!(get(&token).1, "401");
        stop_listener();
        let _ = fs::remove_dir_all(dir);
    }

    /// Hand-run: serves a pairing on 127.0.0.1 for 40 s so another implementation (the phone's Java) can be tried against it.
    #[test]
    #[ignore]
    fn serve_for_interop() {
        let dir = std::env::temp_dir().join("br-sync-interop");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        init(dir);
        st().enabled = true;
        let port = start_listener().unwrap();
        st().offer = Some(Offer { key: "ABCD-EFGH-JKLM-NPQR".into(), until: Instant::now() + Duration::from_secs(120), fails: 0 });
        fs::write("/tmp/br-interop", format!("{port} {}", st().fp)).unwrap();
        thread::sleep(Duration::from_secs(40));
    }
}
