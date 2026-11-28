#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod appcfg;
mod fa;
mod local;
mod meta;
mod os;
mod proxy;
mod sync;
mod updater;

use rust_embed::RustEmbed;
use std::{env, sync::Arc, thread, time::Duration};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Fullscreen, Icon, ResizeDirection, WindowBuilder},
};
#[cfg(windows)]
use tao::platform::windows::WindowBuilderExtWindows;
#[cfg(target_os = "linux")]
use tao::platform::unix::WindowExtUnix;
use tao::event_loop::{EventLoopProxy, EventLoopWindowTarget};
use tiny_http::{Header, Response, Server};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
};
use wry::{PageLoadEvent, WebContext, WebView, WebViewBuilder};
#[cfg(target_os = "linux")]
use wry::WebViewBuilderExtUnix;

#[derive(RustEmbed)]
#[folder = "ui/"]
struct Assets;

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn serve_static(rq: tiny_http::Request, path: &str) {
    let mut p = path.trim_start_matches('/').to_string();
    if p.is_empty() {
        p = "index.html".into();
    }
    match Assets::get(&p) {
        Some(f) => {
            let resp = Response::from_data(f.data.into_owned())
                .with_header(header("Content-Type", mime(&p)))
                .with_header(header("Cache-Control", "no-cache"));
            let _ = rq.respond(resp);
        }
        None => {
            let _ = rq.respond(Response::from_string("not found").with_status_code(404));
        }
    }
}

fn handle(rq: tiny_http::Request) {
    let url = rq.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    match path {
        "/proxy" => proxy::api(rq, query),
        "/save" => proxy::save(rq, query),
        "/open" => proxy::open_external(rq, query),
        "/img" => proxy::image(rq, query),
        "/notify" => proxy::notify(rq),
        p if p.starts_with("/fa/") => {
            let p = p.to_string();
            fa::request(rq, &p)
        }
        p if p.starts_with("/local/") => {
            let p = p.to_string();
            local::local_request(rq, &p, query)
        }
        p if p.starts_with("/remote/") => {
            let p = p.to_string();
            local::remote(rq, &p, query)
        }
        "/update/info" => updater::info(rq),
        "/update/apply" => updater::apply(rq),
        p if p.starts_with("/app/") => {
            let p = p.to_string();
            appcfg::request(rq, &p)
        }
        p if p.starts_with("/sync/") => {
            let p = p.to_string();
            sync::local_request(rq, &p)
        }
        "/ping" => {
            let _ = rq.respond(Response::from_string("board-roamer"));
        }
        _ => {
            let path = path.to_string();
            serve_static(rq, &path)
        }
    }
}

fn is_running(port: u16) -> bool {
    ureq::get(&format!("http://127.0.0.1:{port}/ping"))
        .timeout(Duration::from_millis(600))
        .call()
        .ok()
        .and_then(|r| r.into_string().ok())
        .map_or(false, |b| b == "board-roamer")
}

/// macOS apps need a menu bar for Cmd+C / Cmd+V / Cmd+Q to work inside a web view.
#[cfg(target_os = "macos")]
fn install_menu() {
    use muda::{Menu, PredefinedMenuItem, Submenu};
    let menu = Menu::new();
    let app = Submenu::new("Board Roamer", true);
    let _ = app.append_items(&[
        &PredefinedMenuItem::about(None, None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::hide(None),
        &PredefinedMenuItem::hide_others(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::quit(None),
    ]);
    let edit = Submenu::new("Edit", true);
    let _ = edit.append_items(&[
        &PredefinedMenuItem::undo(None),
        &PredefinedMenuItem::redo(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::cut(None),
        &PredefinedMenuItem::copy(None),
        &PredefinedMenuItem::paste(None),
        &PredefinedMenuItem::select_all(None),
    ]);
    let window = Submenu::new("Window", true);
    let _ = window.append_items(&[&PredefinedMenuItem::minimize(None), &PredefinedMenuItem::fullscreen(None)]);
    let _ = menu.append_items(&[&app, &edit, &window]);
    menu.init_for_nsapp();
    std::mem::forget(menu);
}

/// The system-tray (menu bar) icon that keeps the app reachable while its window is closed.
fn build_tray(proxy: EventLoopProxy<String>) -> Option<TrayIcon> {
    let menu = Menu::new();
    let open = MenuItem::with_id("open", "Open Board Roamer", true, None);
    let quit = MenuItem::with_id("quit", "Quit Board Roamer", true, None);
    menu.append_items(&[&open, &PredefinedMenuItem::separator(), &quit]).ok()?;
    let icon = tray_icon::Icon::from_rgba(include_bytes!("../assets/icon-64.rgba").to_vec(), 64, 64).ok()?;
    let p1 = proxy.clone();
    MenuEvent::set_event_handler(Some(move |e: MenuEvent| {
        let cmd = match e.id.0.as_str() {
            "open" => "show",
            "quit" => "quit",
            _ => return,
        };
        let _ = p1.send_event(cmd.to_string());
    }));
    TrayIconEvent::set_event_handler(Some(move |e: TrayIconEvent| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            let _ = proxy.send_event("show".to_string());
        }
    }));
    TrayIconBuilder::new().with_menu(Box::new(menu)).with_menu_on_left_click(false).with_tooltip("Board Roamer").with_icon(icon).build().ok()
}

/// Percent-encode a link so it can ride inside the app's `#/open?u=` address.
fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// The window where the user signs in to Fur Affinity, or passes its Cloudflare check, on the real site. Passwords and the
/// check stay between the user and FA: the app only reads the cookies the site sets (see src/fa.rs) and closes the window.
struct FaWin {
    webview: WebView,
    window: tao::window::Window,
    _ctx: WebContext,
    login: bool,
    /// reading the person's own watch list: opens it once signed in, takes the names off the page, closes
    watch: bool,
    went: bool,
}

fn open_fa_window(target: &EventLoopWindowTarget<String>, events: EventLoopProxy<String>, login: bool, watch: bool, icon: Option<Icon>) -> Option<FaWin> {
    let window = WindowBuilder::new()
        .with_title(if watch { "Fur Affinity: your watch list" } else if login { "Sign in to Fur Affinity" } else { "Fur Affinity: quick check" })
        .with_window_icon(icon)
        .with_inner_size(LogicalSize::new(1000.0, 780.0))
        .build(target)
        .ok()?;
    // its own profile, so signing out here cannot touch the app's settings
    let mut ctx = WebContext::new(Some(os::data_dir().join("fa-webview")));
    let builder = WebViewBuilder::new_with_web_context(&mut ctx)
        .with_url(if watch { "https://www.furaffinity.net/controls/buddylist/" } else if login { "https://www.furaffinity.net/login/" } else { "https://www.furaffinity.net/" })
        .with_on_page_load_handler(move |ev, _url| {
            if matches!(ev, PageLoadEvent::Finished) {
                let _ = events.send_event("fa:loaded".to_string());
            }
        });
    #[cfg(not(target_os = "linux"))]
    let webview = builder.build(&window).ok()?;
    #[cfg(target_os = "linux")]
    let webview = {
        let vbox = window.default_vbox()?;
        builder.build_gtk(vbox).ok()?
    };
    Some(FaWin { webview, window, _ctx: ctx, login, watch, went: false })
}

/// A page finished loading in the sign-in window: ask it who it is and what it is showing; the answer comes back as "fa:info:...".
fn fa_probe(w: &FaWin, events: EventLoopProxy<String>) {
    // on the watch list page it also reads the users listed there: links to user pages whose text is that user's own name
    // (the list itself; navigation, news and the footer never match). Same rule as parseWatchNames in ui/js/fa-parse.js.
    let js = r#"JSON.stringify({ua:navigator.userAgent,title:document.title,path:location.pathname,host:location.hostname,names:/^\/controls\/buddylist/.test(location.pathname)?[...new Set([...document.querySelectorAll('#site-content a[href*="/user/"]')].map(a=>{const m=/\/user\/([^/?#]+)/.exec(a.getAttribute('href')||'');if(!m)return '';let n=m[1];try{n=decodeURIComponent(n)}catch(e){}const f=s=>String(s||'').toLowerCase().replace(/[\s_~@.\-]+/g,'');return f(a.textContent)===f(n)?n:''}).filter(Boolean))]:[]})"#;
    let _ = w.webview.evaluate_script_with_callback(js, move |raw| {
        // the callback gets the JSON text of a string; unwrap that once
        let inner: String = serde_json::from_str(&raw).unwrap_or_default();
        let _ = events.send_event(format!("fa:info:{inner}"));
    });
}

/// Read what the site gave the window, keep it (src/fa.rs), and close the window once it has done its job.
fn fa_handle_info(fa_win: &mut Option<FaWin>, info: &str) {
    let Some(w) = fa_win.as_ref() else { return };
    let v: serde_json::Value = serde_json::from_str(info).unwrap_or_default();
    if !v["host"].as_str().unwrap_or("").ends_with("furaffinity.net") {
        return; // some other page (a captcha or sign-in provider): leave it alone
    }
    let cookies = w.webview.cookies_for_url("https://www.furaffinity.net/").unwrap_or_default();
    let get = |n: &str| cookies.iter().find(|c| c.name() == n).map(|c| c.value().to_string());
    fa::set_from_window(get("a").as_deref(), get("b").as_deref(), get("cf_clearance").as_deref(), v["ua"].as_str());
    let title = v["title"].as_str().unwrap_or("").to_lowercase();
    let checking = title.starts_with("just a moment") || title.contains("attention required");
    let path = v["path"].as_str().unwrap_or("");
    if w.watch {
        let names: Vec<String> = v["names"].as_array().map(|a| a.iter().filter_map(|n| n.as_str().map(String::from)).collect()).unwrap_or_default();
        if path.starts_with("/controls/buddylist") && !names.is_empty() {
            fa::set_watch(names);
            *fa_win = None;
        } else if !checking && !path.starts_with("/login") && !path.starts_with("/controls/buddylist") && fa::connected() {
            // signed in but on some other page (just after signing in): go to the watch list once
            if let Some(w) = fa_win.as_mut() {
                if !w.went {
                    w.went = true;
                    let _ = w.webview.load_url("https://www.furaffinity.net/controls/buddylist/");
                }
            }
        }
        return;
    }
    let done = if w.login { fa::connected() && !path.starts_with("/login") } else { !checking && get("cf_clearance").is_some() };
    if done {
        *fa_win = None;
    }
}

fn fa_forget_window(fa_win: &mut Option<FaWin>) {
    if let Some(w) = fa_win.take() {
        for c in w.webview.cookies().unwrap_or_default() {
            let _ = w.webview.delete_cookie(&c);
        }
        let _ = &w.window;
    }
    let _ = std::fs::remove_dir_all(os::data_dir().join("fa-webview"));
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("Board Roamer {}", updater::VERSION);
        return;
    }
    // where this copy lives, so other apps (Web Roamer) can start it
    if let Ok(exe) = env::current_exe() {
        let _ = std::fs::write(os::data_dir().join("exe.path"), exe.to_string_lossy().as_bytes());
    }
    let browser_mode = args.iter().any(|a| a == "--browser");
    let want_port: u16 = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse().ok())
        .unwrap_or(4621);

    // Just updated: the previous copy is still shutting down. Wait for it to let go of the port,
    // and sweep up the old executable it left behind.
    if args.iter().any(|a| a == "--after-update") {
        for _ in 0..60 {
            if !is_running(want_port) {
                break;
            }
            thread::sleep(Duration::from_millis(200));
        }
        if let Ok(exe) = env::current_exe() {
            let _ = std::fs::remove_file(exe.with_extension("old"));
        }
    }

    // A stable port keeps the WebView's localStorage origin (your boards, settings) stable.
    // If Board Roamer is already running there, just open another window onto the same server.
    let already = is_running(want_port);
    let mut port = want_port;
    if !already {
        let mut server = None;
        for p in want_port..want_port + 20 {
            if let Ok(s) = Server::http(("127.0.0.1", p)) {
                server = Some((s, p));
                break;
            }
        }
        let (server, bound) = server.expect("could not bind a local port");
        port = bound;
        let server = Arc::new(server);
        sync::init(os::data_dir());
        appcfg::init(os::data_dir());
        local::init(os::data_dir());
        fa::init(os::data_dir());
        for _ in 0..8 {
            let s = server.clone();
            thread::spawn(move || {
                for rq in s.incoming_requests() {
                    thread::spawn(move || handle(rq));
                }
            });
        }
    }
    let url = format!("http://127.0.0.1:{port}/");
    // --open <link>: another app (Web Roamer) asks for a post, search or pool to be shown
    let open_link = args.iter().position(|a| a == "--open").and_then(|i| args.get(i + 1)).filter(|l| l.starts_with("http")).cloned();
    if let (true, Some(link)) = (already && !browser_mode, &open_link) {
        if ureq::post(&format!("{url}app/open")).timeout(Duration::from_millis(1500)).send_string(link).is_ok() {
            return;
        }
    }

    // Already running (maybe hidden in the tray)? Bring that window forward and leave.
    if already && !browser_mode && !args.iter().any(|a| a == "--background" || a == "--minimized") {
        let shown = ureq::post(&format!("{url}app/show")).timeout(Duration::from_millis(1500)).call().is_ok();
        if shown {
            return;
        }
    }
    if already && args.iter().any(|a| a == "--background" || a == "--minimized") {
        return; // started at sign-in twice, or by hand: one copy is enough
    }

    if browser_mode {
        println!("Board Roamer {} running at {url}  (Ctrl+C to stop)", updater::VERSION);
        if !args.iter().any(|a| a == "--no-open") {
            os::open_url(&url);
        }
        loop {
            thread::park();
        }
    }

    let event_loop = EventLoopBuilder::<String>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    appcfg::set_proxy(proxy.clone());
    let fa_events = proxy.clone();
    let tray = build_tray(proxy.clone());
    appcfg::set_tray_ok(tray.is_some());
    // --background: start closed to the tray; --minimized: start minimized. Without a tray, closed becomes minimized.
    let want_closed = args.iter().any(|a| a == "--background");
    let hide_start = want_closed && tray.is_some();
    let minimize_start = args.iter().any(|a| a == "--minimized") || (want_closed && tray.is_none());
    #[cfg(target_os = "macos")]
    install_menu();
    let icon = Icon::from_rgba(include_bytes!("../assets/icon-64.rgba").to_vec(), 64, 64).ok();
    // Windows and Linux get our own title bar (ui/js/titlebar.js); macOS keeps its native window frame.
    #[allow(unused_mut)]
    let mut wb = WindowBuilder::new()
        .with_title("Board Roamer")
        .with_window_icon(icon)
        .with_decorations(cfg!(target_os = "macos"))
        .with_visible(!hide_start)
        .with_inner_size(LogicalSize::new(1480.0, 920.0))
        .with_min_inner_size(LogicalSize::new(720.0, 520.0));
    #[cfg(windows)]
    {
        wb = wb.with_undecorated_shadow(true);
    }
    let window = wb.build(&event_loop).expect("window");
    let mut ctx = WebContext::new(Some(os::data_dir()));
    let builder = WebViewBuilder::new_with_web_context(&mut ctx)
        .with_url(match &open_link {
            Some(l) => format!("{url}#/open?u={}", enc(l)),
            None => url.clone(),
        })
        .with_background_color((10, 17, 19, 255))
        .with_initialization_script(&format!("window.__plat='{}';", os::os_name()))
        .with_ipc_handler(move |req| {
            let _ = proxy.send_event(req.body().to_string());
        });
    #[cfg(not(target_os = "linux"))]
    let webview = builder.build(&window).expect("webview");
    #[cfg(target_os = "linux")]
    let webview = {
        let vbox = window.default_vbox().expect("window layout");
        builder.build_gtk(vbox).expect("webview")
    };

    // minimize only once the web view exists: WebView2 cannot be created inside a minimized window
    if minimize_start {
        window.set_minimized(true);
    }

    let push_state = |window: &tao::window::Window, webview: &wry::WebView| {
        let js = format!(
            "window.__wstate&&window.__wstate({{max:{},fs:{}}})",
            window.is_maximized(),
            window.fullscreen().is_some()
        );
        let _ = webview.evaluate_script(&js);
    };

    // closing the window hides it when the app is meant to keep running (so sync keeps working); otherwise it quits
    let close_or_hide = |window: &tao::window::Window, flow: &mut ControlFlow| {
        if appcfg::background() && appcfg::tray_ok() {
            window.set_visible(false);
        } else {
            *flow = ControlFlow::Exit;
        }
    };

    let mut fa_win: Option<FaWin> = None;
    let fa_icon = Icon::from_rgba(include_bytes!("../assets/icon-64.rgba").to_vec(), 64, 64).ok();
    event_loop.run(move |event, target, flow| {
        let _keep_tray_alive = &tray;
        *flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => close_or_hide(&window, flow),
            Event::WindowEvent { event: WindowEvent::Resized(_), .. } => push_state(&window, &webview),
            Event::UserEvent(cmd) => {
                match cmd.as_str() {
                    "min" => window.set_minimized(true),
                    "max" => window.set_maximized(!window.is_maximized()),
                    "close" => close_or_hide(&window, flow),
                    "quit" => *flow = ControlFlow::Exit,
                    "show" => {
                        window.set_visible(true);
                        window.set_minimized(false);
                        window.set_focus();
                    }
                    c if c.starts_with("open:") => {
                        window.set_visible(true);
                        window.set_minimized(false);
                        window.set_focus();
                        let link = serde_json::to_string(&enc(&c[5..])).unwrap_or_default();
                        let _ = webview.evaluate_script(&format!("location.hash='#/open?u='+{link}"));
                    }
                    "drag" => {
                        if window.fullscreen().is_none() {
                            let _ = window.drag_window();
                        }
                    }
                    "fa:login" | "fa:verify" | "fa:watch" => {
                        let login = cmd == "fa:login" || cmd == "fa:watch";
                        let watch = cmd == "fa:watch";
                        if fa_win.as_ref().map_or(false, |w| w.login == login && w.watch == watch) {
                            if let Some(w) = &fa_win {
                                w.window.set_focus();
                            }
                        } else {
                            fa_win = None; // one window at a time
                            fa_win = open_fa_window(target, fa_events.clone(), login, watch, fa_icon.clone());
                        }
                    }
                    "fa:loaded" => {
                        if let Some(w) = &fa_win {
                            fa_probe(w, fa_events.clone());
                        }
                    }
                    "fa:close" => fa_forget_window(&mut fa_win),
                    c if c.starts_with("fa:info:") => fa_handle_info(&mut fa_win, &c[8..]),
                    "fs:1" => window.set_fullscreen(Some(Fullscreen::Borderless(None))),
                    "fs:0" => window.set_fullscreen(None),
                    c if c.starts_with("title:") => window.set_title(&c[6..]),
                    c if c.starts_with("resize:") => {
                        let dir = match &c[7..] {
                            "N" => Some(ResizeDirection::North),
                            "S" => Some(ResizeDirection::South),
                            "E" => Some(ResizeDirection::East),
                            "W" => Some(ResizeDirection::West),
                            "NE" => Some(ResizeDirection::NorthEast),
                            "NW" => Some(ResizeDirection::NorthWest),
                            "SE" => Some(ResizeDirection::SouthEast),
                            "SW" => Some(ResizeDirection::SouthWest),
                            _ => None,
                        };
                        if let Some(d) = dir {
                            let _ = window.drag_resize_window(d);
                        }
                    }
                    _ => {}
                }
                push_state(&window, &webview);
            }
            _ => {}
        }
    });
}
