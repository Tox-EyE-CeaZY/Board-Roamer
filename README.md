# Board Roamer

A board viewer written in Rust for **Windows, macOS, Linux and Android**. Pull artists, tags and tag combinations into a fast
gallery with a proper viewer. Built for **e621**, with **e926, Danbooru, Gelbooru, Safebooru and Derpibooru** supported too.

Single small executable. The UI is embedded, and a small local server handles rate-limited, cached API
access, so nothing needs installing besides the system web view (WebView2 on Windows, built into macOS, WebKitGTK on Linux).

## Download

Grab the latest build from the [Releases page](../../releases/latest):

| Platform | File |
| --- | --- |
| Windows 64-bit / 32-bit / ARM | `board-roamer-windows-x64.exe` / `-x86.exe` / `-arm64.exe` |
| macOS Apple Silicon / Intel | `BoardRoamer-macos-arm64.zip` / `BoardRoamer-macos-x64.zip` (unzip, then right-click the app and choose Open the first time) |
| Linux 64-bit / ARM | `board-roamer-linux-x64` / `board-roamer-linux-arm64` (`chmod +x`, needs `libwebkit2gtk-4.1`) |
| Android 10+ | `BoardRoamer.apk` (allow "install unknown apps" for your browser) |

The Android APK is universal: one file for ARM and x86 phones, tablets and emulators.
`SHA256SUMS.txt` lists the checksum of every file.

**Background.** On a computer, closing the window keeps Board Roamer running in the system tray (menu bar on macOS), so
your phone can still sync with it. Settings → Background lets you turn that off, start the app when you sign in, and choose
whether it starts closed (tray only), minimized or open. Quit from the tray icon. Opening the app again brings the window back.

**Updates.** Settings → Updates checks this project's GitHub releases. On a computer it downloads the matching build,
verifies it against `SHA256SUMS.txt`, swaps it in and restarts. On Android it downloads the APK and opens the system installer.

## Run from source

```
cargo run --release            # native window
cargo run --release -- --browser            # serve + open in your default browser
cargo run --release -- --browser --no-open  # serve only (http://127.0.0.1:4621)
```

Or build once (`cargo build --release`) and double-click `target\release\board-roamer.exe`.
Launching it a second time reuses the running instance, so your boards are shared.

Your data (boards, trail, settings) lives in the WebView profile: `%LOCALAPPDATA%\BoardRoamer` on Windows,
`~/Library/Application Support/BoardRoamer` on macOS, `~/.local/share/BoardRoamer` on Linux. Downloads go to `Downloads/Board Roamer`.

On Linux, install the web view first: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev libayatana-appindicator3-dev` (the last one is for the tray icon).

## What it does

**Search**
- Tag chips with live autocomplete (category colours, post counts, alias hints).
  Click a chip's glyph to cycle **+ require → − exclude → ≈ any-of**. Double-click to edit.
- One-click **ALL ⇄ ANY** blend for combining several artists/tags into one feed.
- Sort, min score, rating (S/Q/E), media type, shape and age filters. Quick routes: Hot today/week/month, shuffle…
- Focus the empty search box for your **★ starred** and **recent** tags. Star artists and the **Following** route
  OR's them all into one feed.
- Artist / tag **dossier** card: post count, aliases, links, wiki excerpt.

**Gallery**
- Virtualized masonry / justified rows / uniform grid. Thousands of posts stay smooth; infinite scroll.
- Select mode (S, Shift-range), bulk pin and download. Arrow-key navigation + Enter.
- Blacklist with click-to-reveal veils, blur-until-hover, **Cloak** panic key (`` ` ``).

**Viewer**
- Zoom / pan / pinch / rotate, fit ⇄ 100 %, preview-then-original loading, video and GIF support, preloading.
- Tag panel grouped by category, with `+` `−` `★` actions. Info tab (sources, relations, pools). Filmstrip, slideshow, fullscreen.
- Favorite and upvote on e621/Danbooru with an API key. Save to Downloads (native), copy link, open on site.

**Boards & Trail**
- **Boards** are pinned collections (polaroid-style) or **live boards** — saved searches that refresh their cover.
- **Trail** remembers every search; click to re-run, or save it as a board.
- Export/import everything as JSON.

**Follows**
- Follow artists (bell button in the viewer, on an artist's card, or the box on the Follows page). New posts are checked
  quietly in the background and the page sorts by latest activity (or unseen, A–Z, most posts, recently followed), grouped
  by Today / This week / This month…
- Opening a followed artist marks their new posts with a **NEW** badge. Select several and open them as one blended feed.

**Pools & comics**
- Pools are classified automatically: a pool whose pages carry the `comic` tag is a **Comic**, otherwise a Series or Collection.
- Pool page: page-numbered gallery, jump to page, save all pages (numbered, in a folder), pin all, slideshow.
- Viewer pool bar: where you are in the pool, previous/next page (PgUp/PgDn), step into any pool a post belongs to.
- **Comic reader**: one page, two-page spreads (cover alone, wide pages alone), or continuous scroll; left-to-right or
  right-to-left; fit modes; zoom/pan; thumbnails; remembers where you stopped and offers *Continue reading*.

**Video**
- Custom player with a scrubber (buffered ranges + hover time), volume, speed, quality, frame-step and a loop built to avoid
  the blank flash at the wrap point.
- After you stop moving the mouse the info panel and filmstrip fall away and the video grows to fill the window.
- F (or the fullscreen buttons) is true fullscreen: the window itself covers the screen.

**Saved files remember where they came from**
- Downloads carry the post's artist, tags, source links, post URL and the site's original MD5 (as XMP, plus EXIF/PNG text
  where useful) in JPG, PNG, GIF, MP4 and WebM, so a file can always be traced back or reverse-searched later.
  The picture/video data is untouched, but the file hash changes, which is why the original MD5 is stored inside.
  Windows Explorer shows the title, authors and tags for JPG/PNG. Formats that can't hold metadata get a `.xmp` beside them.
  Turn it off under Settings → Data.

**Everywhere**
- Custom title bar with working window controls, drag and edge-resizing.
- Right-click anything for a relevant menu: tiles, the viewer, tags, chips, boards, follows, pools, the trail, the rail.
- Live boards show an **Update board** bar when you change the search you opened from them.

Press `?` in the app for all shortcuts.

## Notes

- e621 asks API clients to identify themselves: set a User-Agent like `BoardRoamer/0.1 (by yourname on e621)` in
  Settings → Source. Rate limiting (≈2 req/s) is handled for you.
- Gelbooru requires a free API key/user ID; Danbooru limits signed-out searches to 2 tags.
- Adding a site: write an adapter in `ui/js/providers.js` (normalise to the shared post shape) and allow its host in `src/proxy.rs`.

## Layout

```
src/main.rs     window, static server, routing
src/proxy.rs    allow-listed API proxy, throttle + cache, saving, image fallback
ui/             embedded frontend (vanilla ES modules, no build step)
  js/providers.js   site adapters, feeds, blacklist
  js/gallery.js     virtualized layout engine
  js/viewer.js      lightbox
  js/search.js      chip search bar
```

## Library, sync and phone

- **Library**: save pools and comics (Add to library on a pool, or right-click one). The Pools tab flags new pages,
  like Follows does for artists, and remembers where you stopped reading.
- **Tabs** (optional): right-click or long-press anything and choose *Open in new tab*, middle-click or Ctrl+click a section or
  card, or press Ctrl+T. The tab bar appears once there is a second tab (on a phone, a count button opens a card switcher).
  Each tab keeps its own search, results and scroll position. Ctrl+W closes, Ctrl+Tab switches, Ctrl+Shift+T reopens.
  Settings → Look → Tabs can turn the bar off or keep it always visible.
  On a computer the first tab is a pinned **Main** tab where you move between Roam, Boards, Follows, Pools and Trail; artists,
  boards and pools you open from it get their own tabs (Settings → Look → *Pinned Main tab*). *Follows freshness* sets how soon
  Follows re-checks for new posts. Each tab keeps its own Back trail: pressing Back (or the mouse's back button) at the start
  of a tab closes it and returns you to the tab you opened it from.
- **Links from the sites**: on Android, links to posts, searches and pools on any supported site offer Board Roamer (Settings → Links
  turns that off, and opens Android's "Open by default" screen where "Open supported links" makes it automatic). On any device,
  pasting such a link into the search box opens it. Derpibooru works without an account; an API key is optional and brings your own filter.
- **Boards across several sites**: right-click a live board → *Sites & tags…* to give it a search per site (spike on e621 *and* Derpibooru).
  Each site has its own tags; suggestions come from each site's autocomplete, and pairs you confirm are remembered and synced. Results are merged
  newest-first and the same picture is shown once (it is matched by the sources the posts list, by links between the posts, or by a picture
  fingerprint), using the copy from the most generous site unless another is clearly bigger; the tile shows a link badge and the viewer lists
  where else it is. Derpibooru comics (`comic:` tags) appear on the Pools page and can be read and saved to the library like e621 pools.
- **Folders** for boards (pin boards and live boards) and for the library's pools and comics: *New folder*, drag a card onto a
  folder or right-click → *Move to folder*. Deleting a folder only moves its contents back out. Folders sync between devices.
- **Local** (Settings → Local, off by default): a gallery of the pictures and videos in folders you choose, on this device and on
  the other devices you sync with. Subfolders show up like boards; files open in the normal viewer; you can tag them (tags stay
  in Board Roamer, never in the file) and the tags Board Roamer embedded in its own downloads are read back. Read-only.
  *Let my other devices browse these folders* shares them over your sync connection (same pairing code). On Android it needs
  "All files access" and keeps sharing alive with the app closed (a quiet "Sharing with your devices" notification). Mac:
  normal folders work, a Photos library is not a folder and cannot be browsed.
- **Notifications** (Settings → Notifications, off by default): a system notification when a check finds new posts from your
  follows, new posts on a live board, or new pages in a saved pool. Text only, never a picture, and generic by default
  (“New posts from your follows”, “Your boards have new updates”). You can opt in to naming followed artists. They only appear
  while the app is in the background, and on Android's lock screen only “New activity” shows. Live boards also show a “N new” mark.
  On Android this keeps working with the app closed (a background check about every 30 minutes, no Google services needed).
- **#blur**: add `#blur` to a blacklist line (`wolf solo #blur`) to blur matching posts instead of hiding them. They stay
  blurred, in the gallery and the viewer, until you tap reveal, even when blacklisting is set to Hide or Off.
- **Sync**: Settings → Sync on the computer turns on sharing and shows an address and a pairing code. Enter them in the
  phone's Settings → Sync. Boards, pins, follows, library, trail, reading progress and look/search settings merge both
  ways over Tailscale or the same Wi-Fi. Logins and layout sizes stay per device.
- **Phone layout**: bottom tab bar, sheets instead of popovers, swipe/pinch/long-press gestures, pull to refresh, Back
  button support, and a touch-friendly comic reader.

## Building and releasing

Every push to `main` builds all platforms in GitHub Actions (`.github/workflows/build.yml`). Pushing a tag publishes a release:

```
git tag v1.4.0
git push origin v1.4.0
```

The tag becomes the app version, the builds are attached to the release together with `SHA256SUMS.txt`, and installed
copies offer the update.

**Android signing.** An Android update only installs over an older version if both are signed with the same key. The key is
never committed. Create it once with `python android/build.py` (it writes `android/board-roamer.keystore` and
`android/keystore.pass`), back both up somewhere private, then add two repository secrets (Settings → Secrets and variables → Actions):

- `ANDROID_KEYSTORE_B64`: the keystore file, base64-encoded (`base64 -w0 android/board-roamer.keystore`)
- `ANDROID_KEYSTORE_PASS`: the contents of `android/keystore.pass`

Local Android build: `python android/build.py` (needs the Android SDK build-tools 34, platform 34 and a JDK).
