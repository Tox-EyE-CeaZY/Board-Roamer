//! "Local": browse the pictures and videos in folders you choose, like a phone's gallery, and (optionally) let your other
//! devices browse them too. Read-only: nothing here writes to, moves or deletes your files.
//!
//! Folders are handed out as "roots" (id + name + path) and every request names a root id and a path *inside* it, so a page
//! can never ask for anything outside the folders you picked. Other devices reach `/local/list|file|thumb` only through the
//! sync listener (pairing code required) and only while sharing is on; the app's own window uses the same routes on loopback.

use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::UNIX_EPOCH,
};
use tiny_http::{Header, Method, Request, Response, StatusCode};

const MAX_FILES: usize = 6000;

struct Cfg {
    dir: PathBuf,
    share: bool,
    roots: Vec<(String, String, PathBuf)>, // id, name, path
}

static CFG: OnceLock<Mutex<Cfg>> = OnceLock::new();
/// Picture sizes and embedded metadata, remembered per file (path + size + modified time) so a folder opens fast the second time.
static INFO: OnceLock<Mutex<std::collections::HashMap<String, (u32, u32, Option<serde_json::Value>)>>> = OnceLock::new();

fn cfg() -> std::sync::MutexGuard<'static, Cfg> {
    CFG.get().expect("local not initialised").lock().unwrap_or_else(|e| e.into_inner())
}

fn hdr(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn reply(rq: Request, code: u16, ctype: &str, body: Vec<u8>) {
    let _ = rq.respond(Response::from_data(body).with_status_code(code).with_header(hdr("Content-Type", ctype)).with_header(hdr("Cache-Control", "no-store")));
}

fn json(rq: Request, code: u16, v: serde_json::Value) {
    reply(rq, code, "application/json", v.to_string().into_bytes());
}

fn param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| percent_encoding::percent_decode_str(&v.replace('+', " ")).decode_utf8_lossy().into_owned())
    })
}

fn root_id(path: &Path) -> String {
    let h = Sha256::digest(path.to_string_lossy().as_bytes());
    h.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

fn save(c: &Cfg) {
    let roots: Vec<_> = c.roots.iter().map(|(id, name, p)| serde_json::json!({ "id": id, "name": name, "path": p.to_string_lossy() })).collect();
    let _ = fs::write(c.dir.join("local.json"), serde_json::json!({ "share": c.share, "roots": roots }).to_string());
}

pub fn init(dir: PathBuf) {
    let v: serde_json::Value = fs::read(dir.join("local.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let roots = v["roots"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    let p = PathBuf::from(r["path"].as_str()?);
                    Some((r["id"].as_str().map(String::from).unwrap_or_else(|| root_id(&p)), r["name"].as_str().unwrap_or("Folder").to_string(), p))
                })
                .collect()
        })
        .unwrap_or_default();
    let _ = CFG.set(Mutex::new(Cfg { dir, share: v["share"].as_bool().unwrap_or(false), roots }));
}

/// May other devices browse this computer's folders?
pub fn sharing() -> bool {
    CFG.get().map(|_| cfg().share).unwrap_or(false)
}

/* ------------------------------------------------------------------ what counts as media */
fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn kind_of(ext: &str) -> Option<&'static str> {
    match ext {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "avif" | "jfif" => Some("image"),
        "mp4" | "webm" | "mov" | "m4v" | "mkv" => Some("video"),
        _ => None,
    }
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

fn hidden(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('$')
}

/* ------------------------------------------------------------------ paths: always inside a root */
fn root_path(id: &str) -> Option<PathBuf> {
    cfg().roots.iter().find(|(i, _, _)| i == id).map(|(_, _, p)| p.clone())
}

/// `rel` is "a/b/c" (no leading slash). Anything that is not a plain name, or that resolves outside the root, is refused.
fn resolve(root: &str, rel: &str) -> Option<PathBuf> {
    let base = root_path(root)?.canonicalize().ok()?;
    let mut p = base.clone();
    for part in rel.split('/').filter(|s| !s.is_empty()) {
        if part == ".." || part == "." || part.contains('\\') || part.contains(':') {
            return None;
        }
        p.push(part);
    }
    let p = p.canonicalize().ok()?;
    p.starts_with(&base).then_some(p)
}

/* ------------------------------------------------------------------ listing */
fn folder_info(dir: &Path) -> (usize, Vec<String>) {
    let Ok(rd) = fs::read_dir(dir) else { return (0, vec![]) };
    let mut count = 0;
    let mut images: Vec<String> = Vec::new();
    for e in rd.flatten().take(4000) {
        let name = e.file_name().to_string_lossy().into_owned();
        if hidden(&name) || !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        match kind_of(&ext_of(Path::new(&name))) {
            Some("image") => {
                count += 1;
                images.push(name);
            }
            Some(_) => count += 1,
            None => {}
        }
    }
    images.sort();
    images.truncate(3);
    (count, images)
}

fn list(rq: Request, query: &str) {
    let root = param(query, "root").unwrap_or_default();
    let rel = param(query, "path").unwrap_or_default();
    if root.is_empty() {
        // the top level: the folders you chose
        let roots: Vec<_> = cfg().roots.clone();
        let folders: Vec<_> = roots
            .iter()
            .filter(|(_, _, p)| p.is_dir())
            .map(|(id, name, p)| {
                let (count, covers) = folder_info(p);
                serde_json::json!({ "id": id, "name": name, "count": count, "covers": covers })
            })
            .collect();
        return json(rq, 200, serde_json::json!({ "roots": true, "folders": folders, "files": [] }));
    }
    let Some(dir) = resolve(&root, &rel) else { return json(rq, 404, serde_json::json!({ "error": "not found" })) };
    let Ok(rd) = fs::read_dir(&dir) else { return json(rq, 404, serde_json::json!({ "error": "cannot read this folder" })) };
    let mut folders = Vec::new();
    let mut files = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if hidden(&name) {
            continue;
        }
        let Ok(t) = e.file_type() else { continue };
        let path = e.path();
        if t.is_dir() {
            let (count, covers) = folder_info(&path);
            folders.push(serde_json::json!({ "name": name, "count": count, "covers": covers }));
        } else if t.is_file() && files.len() < MAX_FILES {
            let ext = ext_of(&path);
            let Some(kind) = kind_of(&ext) else { continue };
            let md = e.metadata().ok();
            let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = md.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            let key = format!("{}|{size}|{mtime}", path.to_string_lossy());
            let cached = INFO.get_or_init(Default::default).lock().unwrap().get(&key).cloned();
            let (w, h, meta) = cached.unwrap_or_else(|| {
                let (w, h) = if kind == "image" { image::image_dimensions(&path).unwrap_or((0, 0)) } else { (0, 0) };
                let meta = crate::meta::read(&path, &ext);
                let mut c = INFO.get_or_init(Default::default).lock().unwrap();
                if c.len() > 60000 {
                    c.clear();
                }
                c.insert(key, (w, h, meta.clone()));
                (w, h, meta)
            });
            let mut f = serde_json::json!({ "name": name, "kind": kind, "ext": ext, "w": w, "h": h, "size": size, "mtime": mtime });
            if let Some(m) = meta {
                f["meta"] = m;
            }
            files.push(f);
        }
    }
    folders.sort_by(|a, b| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()));
    json(rq, 200, serde_json::json!({ "roots": false, "folders": folders, "files": files }));
}

/* ------------------------------------------------------------------ one file, with Range so videos can seek */
fn file(rq: Request, query: &str) {
    let (root, rel) = (param(query, "root").unwrap_or_default(), param(query, "path").unwrap_or_default());
    let Some(p) = resolve(&root, &rel).filter(|p| p.is_file()) else { return json(rq, 404, serde_json::json!({ "error": "not found" })) };
    let ext = ext_of(&p);
    if kind_of(&ext).is_none() {
        return json(rq, 403, serde_json::json!({ "error": "not a picture or video" }));
    }
    let Ok(mut f) = fs::File::open(&p) else { return json(rq, 404, serde_json::json!({ "error": "cannot open" })) };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let range = rq
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("range"))
        .and_then(|h| h.value.as_str().strip_prefix("bytes=").map(String::from));
    let (mut start, mut end, mut code) = (0u64, size.saturating_sub(1), 200u16);
    if let Some(r) = range {
        if let Some((a, b)) = r.split(',').next().unwrap_or("").split_once('-') {
            match (a.trim().parse::<u64>().ok(), b.trim().parse::<u64>().ok()) {
                (Some(a), b) if a < size => (start, end, code) = (a, b.map(|b| b.min(size - 1)).unwrap_or(size - 1), 206),
                (None, Some(n)) if n > 0 => (start, end, code) = (size.saturating_sub(n), size - 1, 206),
                _ => return { let _ = rq.respond(Response::empty(416).with_header(hdr("Content-Range", &format!("bytes */{size}")))); },
            }
        }
    }
    let len = if size == 0 { 0 } else { end - start + 1 };
    let _ = f.seek(SeekFrom::Start(start));
    let mut headers = vec![hdr("Content-Type", mime_of(&ext)), hdr("Accept-Ranges", "bytes"), hdr("Cache-Control", "private, max-age=600")];
    if code == 206 {
        headers.push(hdr("Content-Range", &format!("bytes {start}-{end}/{size}")));
    }
    let _ = rq.respond(Response::new(StatusCode(code), headers, f.take(len), Some(len as usize), None));
}

/* ------------------------------------------------------------------ thumbnails (cached on disk) */
fn placeholder(rq: Request, ext: &str) {
    let svg = format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 240'><rect width='320' height='240' fill='#1a2326'/><path d='M135 90v60l55-30z' fill='#c8ff3d'/><text x='160' y='200' fill='#8aa' font-family='monospace' font-size='20' text-anchor='middle'>{}</text></svg>",
        ext.to_uppercase()
    );
    reply(rq, 200, "image/svg+xml", svg.into_bytes());
}

fn make_thumb(p: &Path, side: u32) -> Option<Vec<u8>> {
    use image::{codecs::jpeg::JpegEncoder, ImageDecoder, ImageReader};
    let mut dec = ImageReader::open(p).ok()?.with_guessed_format().ok()?.into_decoder().ok()?;
    let orient = dec.orientation().ok();
    let mut img = image::DynamicImage::from_decoder(dec).ok()?;
    if let Some(o) = orient {
        img.apply_orientation(o);
    }
    let rgb = img.thumbnail(side, side).to_rgb8();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 82).encode_image(&rgb).ok()?;
    Some(out)
}

fn thumb(rq: Request, query: &str) {
    let (root, rel) = (param(query, "root").unwrap_or_default(), param(query, "path").unwrap_or_default());
    let side: u32 = param(query, "s").and_then(|s| s.parse().ok()).unwrap_or(480).clamp(64, 2400);
    let Some(p) = resolve(&root, &rel).filter(|p| p.is_file()) else { return json(rq, 404, serde_json::json!({ "error": "not found" })) };
    let ext = ext_of(&p);
    match kind_of(&ext) {
        Some("image") => {}
        Some(_) => return placeholder(rq, &ext),
        None => return json(rq, 403, serde_json::json!({ "error": "not a picture or video" })),
    }
    let md = fs::metadata(&p).ok();
    let key = Sha256::digest(format!("{}|{}|{}|{}", p.to_string_lossy(), md.as_ref().map(|m| m.len()).unwrap_or(0), md.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0), side));
    let name: String = key.iter().take(12).map(|b| format!("{b:02x}")).collect();
    let dir = cfg().dir.join("thumbs");
    let cached = dir.join(format!("{name}.jpg"));
    let bytes = fs::read(&cached).ok().or_else(|| {
        let t = make_thumb(&p, side)?;
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(&cached, &t);
        Some(t)
    });
    match bytes {
        Some(b) => {
            let _ = rq.respond(Response::from_data(b).with_header(hdr("Content-Type", "image/jpeg")).with_header(hdr("Cache-Control", "private, max-age=86400")));
        }
        // a format we cannot shrink (avif…): the browser can still show the original
        None => file(rq, query),
    }
}

/* ------------------------------------------------------------------ the three routes other devices may use */
pub fn serve(rq: Request, path: &str, query: &str) {
    if rq.method() != &Method::Get {
        return json(rq, 405, serde_json::json!({ "error": "method not allowed" }));
    }
    match path {
        "/local/list" => list(rq, query),
        "/local/file" => file(rq, query),
        "/local/thumb" => thumb(rq, query),
        _ => json(rq, 404, serde_json::json!({ "error": "not found" })),
    }
}

/* ------------------------------------------------------------------ this computer's own window only */
fn home() -> PathBuf {
    crate::os::home()
}

fn subdirs(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .map(|rd| rd.flatten().filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| !hidden(n)).collect())
        .unwrap_or_default();
    v.sort_by_key(|s| s.to_lowercase());
    v
}

/// The folder picker: GET /local/dirs?path=<folder> -> its sub-folders. No path: the drives (or "/") and your home folder.
fn dirs(rq: Request, query: &str) {
    let path = param(query, "path").unwrap_or_default();
    if path.is_empty() {
        let mut places: Vec<serde_json::Value> = vec![serde_json::json!({ "name": "Home", "path": home().to_string_lossy() })];
        #[cfg(windows)]
        for l in b'A'..=b'Z' {
            let d = format!("{}:\\", l as char);
            if Path::new(&d).exists() {
                places.push(serde_json::json!({ "name": d, "path": d }));
            }
        }
        #[cfg(not(windows))]
        places.push(serde_json::json!({ "name": "/", "path": "/" }));
        return json(rq, 200, serde_json::json!({ "path": "", "parent": null, "places": places, "dirs": [] }));
    }
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return json(rq, 404, serde_json::json!({ "error": "not a folder" }));
    }
    let parent = p.parent().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
    let dirs: Vec<_> = subdirs(&p).into_iter().map(|n| serde_json::json!({ "name": n, "path": p.join(&n).to_string_lossy() })).collect();
    json(rq, 200, serde_json::json!({ "path": p.to_string_lossy(), "parent": parent, "dirs": dirs, "places": [] }));
}

/// GET /local/config -> roots, sharing, suggestions. Changes ride on the query so every platform can make them the same way:
/// ?share=1|0   ?add=<folder>&name=<label>   ?remove=<id>
fn config(rq: Request, query: &str) {
    if !query.is_empty() {
        let mut c = cfg();
        if let Some(s) = param(query, "share") {
            c.share = s == "1";
        }
        if let Some(path) = param(query, "add") {
            let p = PathBuf::from(&path);
            if p.is_dir() && !c.roots.iter().any(|(_, _, x)| *x == p) {
                let name = param(query, "name").filter(|s| !s.trim().is_empty()).or_else(|| p.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_else(|| path.clone());
                c.roots.push((root_id(&p), name, p));
            }
        }
        if let Some(id) = param(query, "remove") {
            c.roots.retain(|(i, _, _)| *i != id);
        }
        save(&c);
    }
    let c = cfg();
    let h = home();
    let quick: Vec<_> = ["Pictures", "Downloads", "Videos", "Documents", "Desktop"]
        .iter()
        .map(|n| (n.to_string(), h.join(n)))
        .filter(|(_, p)| p.is_dir())
        .map(|(n, p)| serde_json::json!({ "name": n, "path": p.to_string_lossy() }))
        .collect();
    let roots: Vec<_> = c.roots.iter().map(|(id, name, p)| serde_json::json!({ "id": id, "name": name, "path": p.to_string_lossy(), "ok": p.is_dir() })).collect();
    let v = serde_json::json!({ "share": c.share, "roots": roots, "quick": quick, "os": crate::os::os_name(), "needsAccess": false });
    drop(c);
    json(rq, 200, v);
}

/// Routes for the app's own window (loopback).
pub fn local_request(rq: Request, path: &str, query: &str) {
    match path {
        "/local/config" => config(rq, query),
        "/local/dirs" => dirs(rq, query),
        _ => serve(rq, path, query),
    }
}

/* ------------------------------------------------------------------ another device's folders, fetched on the window's behalf */
/// `/remote/<device>/local/...`: ask that device (with the pairing code) and hand its answer back, ranges included.
pub fn remote(rq: Request, path: &str, query: &str) {
    let rest = path.strip_prefix("/remote/").unwrap_or("");
    let (id, tail) = rest.split_once('/').unwrap_or((rest, ""));
    let id = percent_encoding::percent_decode_str(id).decode_utf8_lossy().into_owned();
    let tail = format!("/{tail}");
    if !matches!(tail.as_str(), "/local/list" | "/local/file" | "/local/thumb") {
        return json(rq, 404, serde_json::json!({ "error": "not found" }));
    }
    let Some((base, token)) = crate::sync::device_target(&id) else { return json(rq, 404, serde_json::json!({ "error": "that device is not reachable (is it sharing, and is Board Roamer open there?)" })) };
    let url = format!("{base}{tail}?{query}");
    let mut req = ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(5)).timeout_read(std::time::Duration::from_secs(40)).build().get(&url).set("Authorization", &format!("Bearer {token}"));
    if let Some(r) = rq.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("range")) {
        req = req.set("Range", r.value.as_str());
    }
    let resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return json(rq, 502, serde_json::json!({ "error": format!("could not reach that device: {e}") })),
    };
    let code = resp.status();
    let len = resp.header("Content-Length").and_then(|v| v.parse::<usize>().ok());
    let mut headers = vec![hdr("Content-Type", resp.content_type()), hdr("Cache-Control", "no-store")];
    for k in ["Content-Range", "Accept-Ranges"] {
        if let Some(v) = resp.header(k) {
            headers.push(hdr(k, v));
        }
    }
    let _ = rq.respond(Response::new(StatusCode(code), headers, resp.into_reader(), len, None));
}
