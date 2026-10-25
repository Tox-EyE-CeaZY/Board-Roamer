//! Desktop background behaviour: stay alive in the system tray when the window is closed (so the sync hub keeps
//! answering other devices), and optionally start at sign-in. Two small switches, kept in app-config.json.

use std::{
    fs,
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        OnceLock,
    },
};
use tao::event_loop::EventLoopProxy;
use tiny_http::{Header, Method, Request, Response};

static BACKGROUND: AtomicBool = AtomicBool::new(true);
static TRAY_OK: AtomicBool = AtomicBool::new(false);
/// How the app starts at sign-in: 0 hidden in the tray ("closed"), 1 minimized, 2 open.
static START_MODE: AtomicU8 = AtomicU8::new(0);
static DIR: OnceLock<PathBuf> = OnceLock::new();
static PROXY: OnceLock<EventLoopProxy<String>> = OnceLock::new();

pub fn init(dir: PathBuf) {
    let cfg: serde_json::Value = fs::read(dir.join("app-config.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    BACKGROUND.store(cfg["background"].as_bool().unwrap_or(true), Ordering::Relaxed);
    START_MODE.store(mode_from(cfg["startMode"].as_str().unwrap_or("tray")), Ordering::Relaxed);
    let _ = DIR.set(dir);
    // the program may have moved since sign-in start was set up (an update, a new folder): keep the entry pointing at it
    if autostart_enabled() {
        let _ = autostart_set(true);
    }
}

fn mode_from(s: &str) -> u8 {
    match s {
        "minimized" => 1,
        "open" => 2,
        _ => 0,
    }
}
pub fn start_mode() -> &'static str {
    ["tray", "minimized", "open"][START_MODE.load(Ordering::Relaxed).min(2) as usize]
}

fn save() {
    if let Some(d) = DIR.get() {
        let v = serde_json::json!({ "background": BACKGROUND.load(Ordering::Relaxed), "startMode": start_mode() });
        let _ = fs::write(d.join("app-config.json"), v.to_string());
    }
}

/// The command-line flag that makes the sign-in start behave as chosen.
fn start_flag() -> Option<&'static str> {
    match START_MODE.load(Ordering::Relaxed) {
        0 => Some("--background"),
        1 => Some("--minimized"),
        _ => None,
    }
}
#[allow(dead_code)]
fn start_args() -> String {
    start_flag().map(|f| format!(" {f}")).unwrap_or_default()
}

pub fn background() -> bool {
    BACKGROUND.load(Ordering::Relaxed)
}
pub fn set_tray_ok(ok: bool) {
    TRAY_OK.store(ok, Ordering::Relaxed);
}
pub fn tray_ok() -> bool {
    TRAY_OK.load(Ordering::Relaxed)
}
/// Lets the HTTP side ask the window loop to do things ("show").
pub fn set_proxy(p: EventLoopProxy<String>) {
    let _ = PROXY.set(p);
}

/* ------------------------------------------------------------------ start at sign-in */

fn exe() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

pub fn autostart_enabled() -> bool {
    #[cfg(windows)]
    {
        crate::os::quiet(std::process::Command::new("reg").args(["query", RUN_KEY, "/v", "BoardRoamer"])).output().map(|o| o.status.success()).unwrap_or(false)
    }
    #[cfg(target_os = "macos")]
    {
        crate::os::home().join("Library/LaunchAgents/com.boardroamer.app.plist").exists()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::os::home().join(".config/autostart/board-roamer.desktop").exists()
    }
}

pub fn autostart_set(on: bool) -> Result<(), String> {
    let exe = exe().ok_or("cannot find the program")?;
    #[cfg(windows)]
    {
        let mut c = std::process::Command::new("reg");
        if on {
            c.args(["add", RUN_KEY, "/v", "BoardRoamer", "/t", "REG_SZ", "/d", &format!("\"{}\"{}", exe.display(), start_args()), "/f"]);
        } else {
            c.args(["delete", RUN_KEY, "/v", "BoardRoamer", "/f"]);
        }
        let ok = crate::os::quiet(&mut c).output().map(|o| o.status.success()).unwrap_or(false);
        if ok || !on && !autostart_enabled() { Ok(()) } else { Err("Windows would not change the sign-in list".into()) }
    }
    #[cfg(target_os = "macos")]
    {
        let path = crate::os::home().join("Library/LaunchAgents/com.boardroamer.app.plist");
        if !on {
            let _ = fs::remove_file(&path);
            return Ok(());
        }
        let plist = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>com.boardroamer.app</string>\n<key>ProgramArguments</key><array><string>{}</string>{}</array>\n<key>RunAtLoad</key><true/>\n</dict></plist>\n",
            exe.display(),
            start_flag().map(|f| format!("<string>{f}</string>")).unwrap_or_default()
        );
        let _ = fs::create_dir_all(path.parent().unwrap());
        fs::write(path, plist).map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let path = crate::os::home().join(".config/autostart/board-roamer.desktop");
        if !on {
            let _ = fs::remove_file(&path);
            return Ok(());
        }
        let desk = format!(
            "[Desktop Entry]\nType=Application\nName=Board Roamer\nComment=Board viewer\nExec=\"{}\"{}\nX-GNOME-Autostart-enabled=true\nTerminal=false\n",
            exe.display(),
            start_args()
        );
        let _ = fs::create_dir_all(path.parent().unwrap());
        fs::write(path, desk).map_err(|e| e.to_string())
    }
}

/* ------------------------------------------------------------------ HTTP: /app/config, /app/show */

fn json(rq: Request, code: u16, v: serde_json::Value) {
    let _ = rq.respond(
        Response::from_string(v.to_string())
            .with_status_code(code)
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
            .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap()),
    );
}

pub fn request(mut rq: Request, path: &str) {
    match path {
        "/app/show" => {
            if let Some(p) = PROXY.get() {
                let _ = p.send_event("show".into());
            }
            json(rq, 200, serde_json::json!({ "ok": true }));
        }
        // another app (Web Roamer) hands over a link to a post, search or pool: show the window and go there
        "/app/open" => {
            let mut body = String::new();
            let _ = rq.as_reader().take(4096).read_to_string(&mut body);
            let link = body.trim();
            if !(link.starts_with("http://") || link.starts_with("https://")) {
                return json(rq, 400, serde_json::json!({ "error": "not a link" }));
            }
            if let Some(p) = PROXY.get() {
                let _ = p.send_event(format!("open:{link}"));
            }
            json(rq, 200, serde_json::json!({ "ok": true }));
        }
        "/app/config" => {
            if rq.method() == &Method::Post {
                let mut body = String::new();
                let _ = rq.as_reader().take(2048).read_to_string(&mut body);
                let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                if let Some(b) = v["background"].as_bool() {
                    BACKGROUND.store(b, Ordering::Relaxed);
                    save();
                }
                if let Some(m) = v["startMode"].as_str() {
                    START_MODE.store(mode_from(m), Ordering::Relaxed);
                    save();
                    if autostart_enabled() {
                        let _ = autostart_set(true); // rewrite the entry with the new mode
                    }
                }
                if let Some(a) = v["autostart"].as_bool() {
                    if let Err(e) = autostart_set(a) {
                        return json(rq, 500, serde_json::json!({ "error": e }));
                    }
                }
            }
            json(rq, 200, serde_json::json!({ "background": background(), "autostart": autostart_enabled(), "startMode": start_mode(), "tray": tray_ok(), "os": crate::os::os_name() }));
        }
        _ => json(rq, 404, serde_json::json!({ "error": "not found" })),
    }
}
