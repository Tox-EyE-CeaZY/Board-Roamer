# Board Roamer

A native desktop board viewer written in Rust. Pull artists, tags and tag combinations into a fast
gallery with a proper viewer. Built for **e621**, with **e926, Danbooru, Gelbooru and Safebooru** supported too.

Single 3 MB executable. The UI is embedded, and a small local server handles rate-limited, cached API
access, so nothing needs installing besides WebView2 (already part of Windows 11).

## Run

```
cargo run --release            # native window
cargo run --release -- --browser            # serve + open in your default browser
cargo run --release -- --browser --no-open  # serve only (http://127.0.0.1:4621)
```

Or build once (`cargo build --release`) and double-click `target\release\board-roamer.exe`.
Launching it a second time reuses the running instance, so your boards are shared.

Your data (boards, trail, settings) lives in the WebView profile at `%LOCALAPPDATA%\BoardRoamer`.
Downloads go to `Downloads\Board Roamer`.

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
