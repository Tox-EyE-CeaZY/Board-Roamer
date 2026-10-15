#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod meta;
mod proxy;
mod sync;

use rust_embed::RustEmbed;
use std::{env, path::PathBuf, sync::Arc, thread};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    platform::windows::WindowBuilderExtWindows,
    window::{Fullscreen, Icon, ResizeDirection, WindowBuilder},
};
use tiny_http::{Header, Response, Server};
use wry::{WebContext, WebViewBuilder};

#[derive(RustEmbed)]
#[folder = "ui/"]
struct Assets;

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
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

fn data_dir() -> PathBuf {
    let base = env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("XDG_DATA_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    let d = base.join("BoardRoamer");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let browser_mode = args.iter().any(|a| a == "--browser");
    let want_port: u16 = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse().ok())
        .unwrap_or(4621);

    // A stable port keeps the WebView's localStorage origin (your boards, settings) stable.
    // If Board Roamer is already running there, just open another window onto the same server.
    let already = ureq::get(&format!("http://127.0.0.1:{want_port}/ping"))
        .timeout(std::time::Duration::from_millis(600))
        .call()
        .ok()
        .and_then(|r| r.into_string().ok())
        .map_or(false, |b| b == "board-roamer");
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
        sync::init(data_dir());
        let server = Arc::new(server);
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

    if browser_mode {
        println!("Board Roamer running at {url}  (Ctrl+C to stop)");
        if !args.iter().any(|a| a == "--no-open") {
            proxy::open_url(&url);
        }
        loop {
            thread::park();
        }
    }

    let event_loop = EventLoopBuilder::<String>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let icon = Icon::from_rgba(include_bytes!("../assets/icon-64.rgba").to_vec(), 64, 64).ok();
    let window = WindowBuilder::new()
        .with_title("Board Roamer")
        .with_window_icon(icon)
        .with_decorations(false) // we draw our own title bar (ui/js/titlebar.js)
        .with_undecorated_shadow(true)
        .with_inner_size(LogicalSize::new(1480.0, 920.0))
        .with_min_inner_size(LogicalSize::new(720.0, 520.0))
        .build(&event_loop)
        .expect("window");
    let mut ctx = WebContext::new(Some(data_dir()));
    let webview = WebViewBuilder::new_with_web_context(&mut ctx)
        .with_url(&url)
        .with_background_color((10, 17, 19, 255))
        .with_ipc_handler(move |req| {
            let _ = proxy.send_event(req.body().to_string());
        })
        .build(&window)
        .expect("webview");

    let push_state = |window: &tao::window::Window, webview: &wry::WebView| {
        let js = format!(
            "window.__wstate&&window.__wstate({{max:{},fs:{}}})",
            window.is_maximized(),
            window.fullscreen().is_some()
        );
        let _ = webview.evaluate_script(&js);
    };

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *flow = ControlFlow::Exit,
            Event::WindowEvent { event: WindowEvent::Resized(_), .. } => push_state(&window, &webview),
            Event::UserEvent(cmd) => {
                match cmd.as_str() {
                    "min" => window.set_minimized(true),
                    "max" => window.set_maximized(!window.is_maximized()),
                    "close" => *flow = ControlFlow::Exit,
                    "drag" => {
                        if window.fullscreen().is_none() {
                            let _ = window.drag_window();
                        }
                    }
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
