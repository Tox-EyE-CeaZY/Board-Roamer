//! Embed a post's metadata into the file that gets saved, so an image or video still says where it
//! came from (site, post id, artists, tags, sources, original MD5) after it leaves the app.
//!
//! * XMP (Dublin Core + a small `br:` namespace, including the complete record as JSON) goes into every
//!   supported container: JPEG, PNG, GIF, MP4/MOV and WebM/Matroska.
//! * JPEG also gets Windows-friendly EXIF tags (Title / Authors / Keywords / Comment) when it has no EXIF yet.
//! * PNG also gets plain tEXt chunks, GIF a comment block.
//! * Anything else (WebP without VP8X, SWF, …) gets a `.xmp` sidecar next to it.
//!
//! The pixel/stream data is never touched, only metadata is added, but the file hash therefore differs from the
//! site's: the original MD5 is stored inside the metadata so a lookup (`md5:…`) still works.

use serde_json::Value;
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

const NS_BR: &str = "https://github.com/board-roamer/ns/1.0/";

/* ------------------------------------------------------------------ helpers */
fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => {}
            c => o.push(c),
        }
    }
    o
}

fn text(m: &Value, k: &str) -> String {
    match m.get(k) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string(),
    }
}

fn list(m: &Value, k: &str) -> Vec<String> {
    m.get(k)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| match x {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn title(m: &Value) -> String {
    let a = list(m, "artists");
    let base = format!("{} #{}", text(m, "site"), text(m, "id"));
    if a.is_empty() {
        base
    } else {
        format!("{} — {}", a.iter().take(3).cloned().collect::<Vec<_>>().join(", "), base)
    }
}

fn ascii(s: &str) -> Vec<u8> {
    let mut v: Vec<u8> = s.chars().map(|c| if c.is_ascii() && c != '\0' { c as u8 } else { b'?' }).collect();
    v.push(0);
    v
}

fn utf16z(s: &str) -> Vec<u8> {
    let mut v: Vec<u8> = s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    v.extend_from_slice(&[0, 0]);
    v
}

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for n in 0..256u32 {
        let mut c = n;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        table[n as usize] = c;
    }
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = table[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

/* ------------------------------------------------------------------ XMP */
fn build_xmp(m: &Value, tags: &[String], with_json: bool) -> String {
    let artists = list(m, "artists");
    let sources = list(m, "sources");
    let pools = list(m, "pools");
    let bag = |name: &str, items: &[String], kind: &str| -> String {
        if items.is_empty() {
            return String::new();
        }
        let lis: String = items.iter().map(|i| format!("<rdf:li>{}</rdf:li>", esc(i))).collect();
        format!("<{name}><rdf:{kind}>{lis}</rdf:{kind}></{name}>")
    };
    let desc = {
        let d = text(m, "desc");
        if d.trim().is_empty() { format!("{} · {}", title(m), text(m, "url")) } else { d }
    };
    let ident = vec![format!("{}:{}", text(m, "siteId"), text(m, "id")), format!("md5:{}", text(m, "md5"))];
    let mut x = String::new();
    x.push_str("<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n");
    x.push_str("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n");
    x.push_str(&format!(
        "<rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:br=\"{NS_BR}\">\n"
    ));
    x.push_str(&format!("<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:title>\n", esc(&title(m))));
    x.push_str(&bag("dc:creator", &artists, "Seq"));
    x.push_str(&bag("dc:subject", tags, "Bag"));
    x.push_str(&format!("<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:description>\n", esc(&desc)));
    x.push_str(&format!("<dc:source>{}</dc:source>\n", esc(&text(m, "url"))));
    x.push_str(&bag("dc:identifier", &ident, "Bag"));
    x.push_str("<xmp:CreatorTool>Board Roamer</xmp:CreatorTool>\n");
    for (k, v) in [("site", text(m, "site")), ("siteId", text(m, "siteId")), ("postId", text(m, "id")), ("md5", text(m, "md5")), ("postUrl", text(m, "url")),
        ("fileUrl", text(m, "fullUrl")), ("rating", text(m, "rating")), ("score", text(m, "score")), ("favorites", text(m, "favs")),
        ("posted", text(m, "posted")), ("parent", text(m, "parent"))]
    {
        if !v.is_empty() {
            x.push_str(&format!("<br:{k}>{}</br:{k}>\n", esc(&v)));
        }
    }
    x.push_str(&bag("br:sources", &sources, "Bag"));
    x.push_str(&bag("br:pools", &pools, "Bag"));
    x.push_str(&format!("<br:tagString>{}</br:tagString>\n", esc(&tags.join(" "))));
    if with_json {
        x.push_str(&format!("<br:json>{}</br:json>\n", esc(&m.to_string())));
    }
    x.push_str("</rdf:Description>\n</rdf:RDF></x:xmpmeta>\n<?xpacket end=\"w\"?>");
    x
}

/// Build an XMP packet no larger than `max` bytes by shedding the JSON blob, then tags, if it has to.
pub fn xmp(m: &Value, max: usize) -> String {
    let mut tags = list(m, "tags");
    let full = build_xmp(m, &tags, true);
    if full.len() <= max {
        return full;
    }
    loop {
        let x = build_xmp(m, &tags, false);
        if x.len() <= max || tags.is_empty() {
            return x;
        }
        let keep = tags.len() * 3 / 4;
        tags.truncate(keep);
    }
}

/* ------------------------------------------------------------------ JPEG */
const XMP_HDR: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

fn exif_block(m: &Value) -> Vec<u8> {
    let artists = list(m, "artists").join("; ");
    let tags = list(m, "tags");
    let ttl = title(m);
    let comment = format!("{} | {} | md5:{}", text(m, "url"), text(m, "siteId"), text(m, "md5"));
    // (tag, type, bytes, count)
    let mut ents: Vec<(u16, u16, Vec<u8>, u32)> = vec![];
    let a = ascii(&ttl);
    ents.push((0x010E, 2, a.clone(), a.len() as u32));
    let sw = ascii("Board Roamer");
    ents.push((0x0131, 2, sw.clone(), sw.len() as u32));
    if !artists.is_empty() {
        let a = ascii(&artists);
        ents.push((0x013B, 2, a.clone(), a.len() as u32));
    }
    for (tag, s) in [(0x9C9Bu16, ttl.clone()), (0x9C9C, comment), (0x9C9D, artists.clone()), (0x9C9E, tags.join(";"))] {
        if s.is_empty() {
            continue;
        }
        let b = utf16z(&s);
        ents.push((tag, 1, b.clone(), b.len() as u32));
    }
    ents.sort_by_key(|e| e.0);
    let n = ents.len();
    let mut out = Vec::new();
    out.extend_from_slice(b"II*\0");
    out.extend_from_slice(&8u32.to_le_bytes());
    out.extend_from_slice(&(n as u16).to_le_bytes());
    let mut data_off = 8 + 2 + n * 12 + 4;
    let mut tail: Vec<u8> = Vec::new();
    for (tag, typ, bytes, count) in &ents {
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&typ.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        if bytes.len() <= 4 {
            let mut v = bytes.clone();
            v.resize(4, 0);
            out.extend_from_slice(&v);
        } else {
            out.extend_from_slice(&(data_off as u32).to_le_bytes());
            tail.extend_from_slice(bytes);
            if bytes.len() % 2 == 1 {
                tail.push(0);
            }
            data_off = 8 + 2 + n * 12 + 4 + tail.len();
        }
    }
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&tail);
    let mut seg = b"Exif\0\0".to_vec();
    seg.extend_from_slice(&out);
    seg
}

fn app1(payload: &[u8]) -> Option<Vec<u8>> {
    let len = payload.len() + 2;
    if len > 0xFFFF {
        return None;
    }
    let mut v = vec![0xFF, 0xE1];
    v.extend_from_slice(&(len as u16).to_be_bytes());
    v.extend_from_slice(payload);
    Some(v)
}

fn jpeg(b: &[u8], m: &Value) -> Option<Vec<u8>> {
    if b.len() < 4 || b[0] != 0xFF || b[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    let (mut app0, mut kept, mut has_exif) = (Vec::new(), Vec::new(), false);
    while i + 4 <= b.len() && b[i] == 0xFF {
        let mk = b[i + 1];
        if mk == 0xDA || mk == 0xD9 || mk == 0xD8 || (0xD0..=0xD7).contains(&mk) || mk == 0x01 {
            break;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        let end = i + 2 + len;
        if end > b.len() || len < 2 {
            return None;
        }
        let seg = &b[i..end];
        if mk == 0xE0 && app0.is_empty() && kept.is_empty() {
            app0 = seg.to_vec();
        } else if mk == 0xE1 && seg[4..].starts_with(XMP_HDR) {
            // an older XMP packet: replaced by ours
        } else {
            if mk == 0xE1 && seg[4..].starts_with(b"Exif\0\0") {
                has_exif = true;
            }
            kept.extend_from_slice(seg);
        }
        i = end;
    }
    let x = xmp(m, 65000 - XMP_HDR.len());
    let mut payload = XMP_HDR.to_vec();
    payload.extend_from_slice(x.as_bytes());
    let xmp_seg = app1(&payload)?;
    let mut out = Vec::with_capacity(b.len() + xmp_seg.len() + 2048);
    out.extend_from_slice(&[0xFF, 0xD8]);
    out.extend_from_slice(&app0);
    if !has_exif {
        if let Some(e) = app1(&exif_block(m)) {
            out.extend_from_slice(&e);
        }
    }
    out.extend_from_slice(&xmp_seg);
    out.extend_from_slice(&kept);
    out.extend_from_slice(&b[i..]);
    Some(out)
}

/* ------------------------------------------------------------------ PNG */
fn png_chunk(typ: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(data.len() + 12);
    v.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut body = typ.to_vec();
    body.extend_from_slice(data);
    v.extend_from_slice(&body);
    v.extend_from_slice(&crc32(&body).to_be_bytes());
    v
}

fn latin1(s: &str) -> Vec<u8> {
    s.chars().map(|c| if (c as u32) < 256 && c != '\0' { c as u8 } else { b'?' }).collect()
}

fn png(b: &[u8], m: &Value) -> Option<Vec<u8>> {
    if b.len() < 33 || &b[..8] != b"\x89PNG\r\n\x1a\n" || &b[12..16] != b"IHDR" {
        return None;
    }
    let ihdr_end = 8 + 12 + u32::from_be_bytes([b[8], b[9], b[10], b[11]]) as usize;
    let mut add = Vec::new();
    let mut itxt = b"XML:com.adobe.xmp\0\0\0\0\0".to_vec();
    itxt.extend_from_slice(xmp(m, usize::MAX).as_bytes());
    add.extend(png_chunk(b"iTXt", &itxt));
    let t = |k: &str, v: &str| -> Vec<u8> {
        let mut d = k.as_bytes().to_vec();
        d.push(0);
        d.extend(latin1(v));
        png_chunk(b"tEXt", &d)
    };
    add.extend(t("Title", &title(m)));
    let artists = list(m, "artists").join(", ");
    if !artists.is_empty() {
        add.extend(t("Author", &artists));
    }
    add.extend(t("Source", &text(m, "url")));
    add.extend(t("Description", &format!("{} | md5:{}", text(m, "url"), text(m, "md5"))));
    let tags = list(m, "tags").join(" ");
    add.extend(t("Comment", &tags.chars().take(30000).collect::<String>()));
    add.extend(t("Software", "Board Roamer"));
    let mut out = Vec::with_capacity(b.len() + add.len());
    out.extend_from_slice(&b[..ihdr_end]);
    out.extend_from_slice(&add);
    out.extend_from_slice(&b[ihdr_end..]);
    Some(out)
}

/* ------------------------------------------------------------------ GIF */
fn gif(b: &[u8], m: &Value) -> Option<Vec<u8>> {
    if b.len() < 14 || &b[..4] != b"GIF8" {
        return None;
    }
    let flags = b[10];
    let gct = if flags & 0x80 != 0 { 3 * (2usize << (flags & 7)) } else { 0 };
    let mut pos = 13 + gct;
    if b.len() > pos + 19 && b[pos..pos + 3] == [0x21, 0xFF, 0x0B] && &b[pos + 3..pos + 14] == b"NETSCAPE2.0" {
        pos += 19; // keep the loop extension first
    }
    if pos > b.len() {
        return None;
    }
    let mut add = Vec::new();
    let comment = format!("{} | {} | md5:{} | tags: {}", title(m), text(m, "url"), text(m, "md5"), list(m, "tags").join(" "));
    add.extend_from_slice(&[0x21, 0xFE]);
    for chunk in comment.as_bytes().chunks(255) {
        add.push(chunk.len() as u8);
        add.extend_from_slice(chunk);
    }
    add.push(0);
    add.extend_from_slice(&[0x21, 0xFF, 0x0B]);
    add.extend_from_slice(b"XMP DataXMP");
    add.extend_from_slice(xmp(m, usize::MAX).as_bytes());
    add.push(0x01);
    for v in (0..=0xFFu16).rev() {
        add.push(v as u8);
    }
    add.push(0x00);
    let mut out = Vec::with_capacity(b.len() + add.len());
    out.extend_from_slice(&b[..pos]);
    out.extend_from_slice(&add);
    out.extend_from_slice(&b[pos..]);
    Some(out)
}

/* ------------------------------------------------------------------ MP4 / MOV */
fn mp4_append(path: &Path, m: &Value) -> Result<(), String> {
    let mut f = fs::OpenOptions::new().read(true).append(true).open(path).map_err(|e| e.to_string())?;
    let mut head = [0u8; 12];
    f.read_exact(&mut head).map_err(|e| e.to_string())?;
    if &head[4..8] != b"ftyp" {
        return Err("not an ISO media file".into());
    }
    let x = xmp(m, usize::MAX);
    let mut boxed = Vec::with_capacity(x.len() + 24);
    boxed.extend_from_slice(&((x.len() + 24) as u32).to_be_bytes());
    boxed.extend_from_slice(b"uuid");
    boxed.extend_from_slice(&[0xBE, 0x7A, 0xCF, 0xCB, 0x97, 0xA9, 0x42, 0xE8, 0x9C, 0x71, 0x99, 0x94, 0x91, 0xE3, 0xAF, 0xAC]);
    boxed.extend_from_slice(x.as_bytes());
    f.write_all(&boxed).map_err(|e| e.to_string())
}

/* ------------------------------------------------------------------ WebM / Matroska */
fn vint_width(first: u8) -> usize {
    first.leading_zeros() as usize + 1
}

fn ebml_size(len: usize) -> Vec<u8> {
    let mut w = 1;
    while w < 8 && (len as u64) >= (1u64 << (7 * w)) - 1 {
        w += 1;
    }
    vint_fixed(len as u64, w)
}

fn vint_fixed(v: u64, w: usize) -> Vec<u8> {
    let mut out = vec![0u8; w];
    for i in 0..w {
        out[w - 1 - i] = ((v >> (8 * i)) & 0xFF) as u8;
    }
    out[0] |= (1u16 << (8 - w)) as u8;
    out
}

fn elem(id: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut v = id.to_vec();
    v.extend(ebml_size(payload.len()));
    v.extend_from_slice(payload);
    v
}

fn simple_tag(name: &str, val: &str) -> Vec<u8> {
    let mut p = elem(&[0x45, 0xA3], name.as_bytes());
    p.extend(elem(&[0x44, 0x87], val.as_bytes()));
    elem(&[0x67, 0xC8], &p)
}

fn mkv_tags(m: &Value) -> Vec<u8> {
    let tags = list(m, "tags").join(" ");
    let json = m.to_string();
    let pairs: Vec<(&str, String)> = vec![
        ("TITLE", title(m)),
        ("ARTIST", list(m, "artists").join("; ")),
        ("KEYWORDS", tags),
        ("DESCRIPTION", text(m, "desc")),
        ("PURL", text(m, "url")),
        ("COMMENT", format!("{} #{} md5:{}", text(m, "site"), text(m, "id"), text(m, "md5"))),
        ("BOARDROAMER_SITE", text(m, "siteId")),
        ("BOARDROAMER_ID", text(m, "id")),
        ("MD5", text(m, "md5")),
        ("RATING", text(m, "rating")),
        ("SOURCES", list(m, "sources").join(" ")),
        ("BOARDROAMER_JSON", json),
    ];
    let mut tag = elem(&[0x63, 0xC0], &[]); // Targets (whole file)
    for (k, v) in pairs {
        if !v.is_empty() {
            tag.extend(simple_tag(k, &v));
        }
    }
    elem(&[0x12, 0x54, 0xC3, 0x67], &elem(&[0x73, 0x73], &tag))
}

fn mkv_patch(path: &Path, m: &Value) -> Result<(), String> {
    let mut f = fs::OpenOptions::new().read(true).write(true).open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let mut head = [0u8; 16];
    f.read_exact(&mut head).map_err(|e| e.to_string())?;
    if head[..4] != [0x1A, 0x45, 0xDF, 0xA3] {
        return Err("not a Matroska/WebM file".into());
    }
    let w1 = vint_width(head[4]);
    let mut sz = (head[4] as u64) & (0xFFu16 >> w1) as u64;
    for i in 1..w1 {
        sz = (sz << 8) | head[4 + i] as u64;
    }
    let seg_pos = 4 + w1 as u64 + sz;
    f.seek(SeekFrom::Start(seg_pos)).map_err(|e| e.to_string())?;
    let mut seg = [0u8; 12];
    f.read_exact(&mut seg).map_err(|e| e.to_string())?;
    if seg[..4] != [0x18, 0x53, 0x80, 0x67] {
        return Err("segment not found".into());
    }
    let w = vint_width(seg[4]);
    if w > 8 {
        return Err("bad segment size".into());
    }
    let mut size = (seg[4] as u64) & (0xFFu16 >> w) as u64;
    for i in 1..w {
        size = (size << 8) | seg[4 + i] as u64;
    }
    let unknown = size == (1u64 << (7 * w)) - 1;
    let data_start = seg_pos + 4 + w as u64;
    if !unknown && data_start + size != len {
        return Err("data after the segment".into());
    }
    let tags = mkv_tags(m);
    let new_size = size + tags.len() as u64;
    if !unknown && new_size >= (1u64 << (7 * w)) - 1 {
        return Err("segment size field too small".into());
    }
    f.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    f.write_all(&tags).map_err(|e| e.to_string())?;
    if !unknown {
        f.seek(SeekFrom::Start(seg_pos + 4)).map_err(|e| e.to_string())?;
        f.write_all(&vint_fixed(new_size, w)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ------------------------------------------------------------------ public API */
pub fn is_image(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "png" | "gif")
}

/// Embed into an in-memory image. `None` means "unsupported or malformed: leave it alone".
pub fn embed_bytes(ext: &str, data: &[u8], m: &Value) -> Option<Vec<u8>> {
    match ext {
        "jpg" | "jpeg" => jpeg(data, m),
        "png" => png(data, m),
        "gif" => gif(data, m),
        _ => None,
    }
}

/// Patch a video that is already on disk. Returns true when the metadata is inside the file.
pub fn embed_file(path: &Path, ext: &str, m: &Value) -> bool {
    match ext {
        "mp4" | "m4v" | "mov" => mp4_append(path, m).is_ok(),
        "webm" | "mkv" => mkv_patch(path, m).is_ok(),
        _ => false,
    }
}

/// `<file>.xmp` next to the download, for formats we can't write into.
pub fn write_sidecar(path: &Path, m: &Value) -> bool {
    let mut p = path.as_os_str().to_owned();
    p.push(".xmp");
    fs::write(p, xmp(m, usize::MAX)).is_ok()
}

/* ------------------------------------------------------------------ reading it back (the Local gallery) */
fn unesc(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn between<'a>(s: &'a str, a: &str, b: &str) -> Option<&'a str> {
    let i = s.find(a)? + a.len();
    let j = s[i..].find(b)? + i;
    Some(&s[i..j])
}

fn li_items(s: &str, tag: &str) -> Vec<String> {
    let Some(block) = between(s, &format!("<{tag}>"), &format!("</{tag}>")) else { return vec![] };
    block.split("<rdf:li").skip(1).filter_map(|x| x.split_once('>').and_then(|(_, r)| r.split("</rdf:li>").next()).map(unesc)).filter(|x| !x.is_empty()).collect()
}

/// What Board Roamer (or any XMP-aware tool) wrote into a file: tags, artists and where it came from. Compact, for listings.
fn compact(full: &Value) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for k in ["site", "siteId", "id", "url", "md5", "rating", "score", "posted", "fullUrl"] {
        if let Some(v) = full.get(k).filter(|v| !v.is_null()) {
            out.insert(k.into(), v.clone());
        }
    }
    for k in ["artists", "sources"] {
        out.insert(k.into(), Value::Array(list(full, k).into_iter().map(Value::String).collect()));
    }
    out.insert("tags".into(), Value::Array(list(full, "tags").into_iter().map(Value::String).collect()));
    if let Some(c) = full.get("tagsByCategory").filter(|v| v.is_object()) {
        out.insert("byCat".into(), c.clone());
    }
    out
}

/// WebM / Matroska keep the record as a SimpleTag named BOARDROAMER_JSON: [name][0x4487 size value].
fn mkv_record(buf: &[u8]) -> Option<Value> {
    let name = b"BOARDROAMER_JSON";
    let at = buf.windows(name.len()).position(|w| w == name)? + name.len();
    let rest = buf.get(at..)?;
    if rest.len() < 3 || rest[0] != 0x44 || rest[1] != 0x87 {
        return None;
    }
    let w = vint_width(rest[2]);
    let mut size = (rest[2] as usize) & (0xFFusize >> w);
    for i in 1..w {
        size = (size << 8) | *rest.get(2 + i)? as usize;
    }
    let start = 2 + w;
    serde_json::from_slice(rest.get(start..start + size)?).ok()
}

fn parse_xmp(x: &str) -> Option<Value> {
    let mut out = serde_json::Map::new();
    if let Some(full) = between(x, "<br:json>", "</br:json>").and_then(|j| serde_json::from_str::<Value>(&unesc(j)).ok()) {
        out = compact(&full);
    } else {
        let mut tags = li_items(x, "dc:subject");
        if tags.is_empty() {
            tags = between(x, "<br:tagString>", "</br:tagString>").map(|t| unesc(t).split_whitespace().map(String::from).collect()).unwrap_or_default();
        }
        for (k, el) in [("site", "br:site"), ("siteId", "br:siteId"), ("id", "br:postId"), ("url", "br:postUrl"), ("md5", "br:md5"), ("rating", "br:rating")] {
            if let Some(v) = between(x, &format!("<{el}>"), &format!("</{el}>")) {
                out.insert(k.into(), Value::String(unesc(v)));
            }
        }
        out.insert("artists".into(), Value::Array(li_items(x, "dc:creator").into_iter().map(Value::String).collect()));
        out.insert("sources".into(), Value::Array(li_items(x, "br:sources").into_iter().map(Value::String).collect()));
        out.insert("tags".into(), Value::Array(tags.into_iter().map(Value::String).collect()));
    }
    let has = out.get("tags").and_then(|t| t.as_array()).map_or(false, |t| !t.is_empty()) || out.contains_key("siteId");
    has.then(|| Value::Object(out))
}

/// Read the XMP packet out of a file's head (images, WebM) or tail (MP4/MOV), or from a `.xmp` sidecar beside it.
pub fn read(path: &Path, ext: &str) -> Option<Value> {
    let mut f = fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let tail = matches!(ext, "mp4" | "m4v" | "mov" | "webm" | "mkv"); // appended at the end of video files
    let (head, tailn) = (96 * 1024u64, 160 * 1024u64);
    let mut buf = Vec::new();
    if len <= head + tailn {
        f.read_to_end(&mut buf).ok()?;
    } else if tail {
        f.seek(SeekFrom::Start(len - tailn)).ok()?;
        f.take(tailn).read_to_end(&mut buf).ok()?;
    } else {
        f.take(head).read_to_end(&mut buf).ok()?;
    }
    if matches!(ext, "webm" | "mkv") {
        if let Some(m) = mkv_record(&buf).map(|r| compact(&r)).filter(|m| m.get("tags").map_or(false, |t| t.as_array().map_or(false, |a| !a.is_empty())) || m.contains_key("siteId")) {
            return Some(Value::Object(m));
        }
    }
    let find = |h: &[u8], n: &[u8]| h.windows(n.len()).position(|w| w == n);
    let packet = find(&buf, b"<x:xmpmeta").and_then(|i| find(&buf[i..], b"</x:xmpmeta>").map(|j| String::from_utf8_lossy(&buf[i..i + j + 12]).into_owned()));
    if let Some(x) = packet.and_then(|x| parse_xmp(&x)) {
        return Some(x);
    }
    let mut side = path.as_os_str().to_owned();
    side.push(".xmp");
    let sc = fs::read(side).ok().filter(|b| b.len() < (1 << 20))?;
    parse_xmp(&String::from_utf8_lossy(&sc))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Value {
        serde_json::json!({"site":"e621","siteId":"e621","id":123,"md5":"abc","url":"https://e621.net/posts/123","artists":["a_b"],"tags":["wolf","solo","t<&>"],"rating":"s","sources":["https://x"],"pools":[5]})
    }
    #[test]
    fn jpeg_roundtrip() {
        let b = [0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xDA, 0, 2, 1, 2, 3, 0xFF, 0xD9];
        let o = jpeg(&b, &sample()).unwrap();
        assert!(o.windows(10).any(|w| w == b"dc:subject"));
        assert_eq!(&o[..2], &[0xFF, 0xD8]);
        assert!(o.ends_with(&[0xFF, 0xD9]));
    }
    #[test]
    fn mkv_roundtrip() {
        let mut m = sample();
        m["tagsByCategory"] = serde_json::json!({"general":["wolf","solo"],"artist":["a_b"]});
        let bytes = mkv_tags(&m);
        let r = compact(&mkv_record(&bytes).unwrap());
        assert_eq!(r["tags"][0], "wolf");
        assert_eq!(r["byCat"]["artist"][0], "a_b");
        assert_eq!(r["siteId"], "e621");
    }
    #[test]
    fn xmp_roundtrip() {
        let r = parse_xmp(&xmp(&sample(), usize::MAX)).unwrap();
        assert_eq!(r["tags"][2], "t<&>");
        assert_eq!(r["id"], 123);
    }
    #[test]
    fn png_has_crc() {
        assert_eq!(crc32(b"IEND"), 0xAE426082);
    }
    #[test]
    fn vints() {
        assert_eq!(vint_fixed(5, 1), vec![0x85]);
        assert_eq!(vint_fixed(300, 2), vec![0x41, 0x2C]);
        assert_eq!(ebml_size(100), vec![0xE4]);
    }
}
