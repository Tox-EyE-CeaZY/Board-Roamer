fn main() {
    println!("cargo:rerun-if-changed=assets/icon.ico");
    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/icon.ico");
        res.set("ProductName", "Board Roamer");
        res.set("FileDescription", "Board Roamer - multi-booru board viewer");
        if let Err(e) = res.compile() {
            println!("cargo:warning=could not embed exe icon: {e}");
        }
    }
}
