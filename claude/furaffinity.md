# Fur Affinity in Board Roamer

Its own section (`#/fa`, nav "Fur Affinity", Settings > Fur Affinity, off by default, computers only). It is not a board: Fur Affinity (FA) has no API, so it is read by scraping pages, one request a second.

## Rules the code enforces
- Claude agents must never browse furaffinity.net (robots.txt). Test fixtures in `tools/fa-fixtures/` are scrubbed pages Maven saved; keep them free of the account name and fav/watch/logout keys.
- `src/fa.rs` `path_allowed` is an allow-list (front page, browse, view, user, gallery, scraps, favorites, journals). Search, msg, fav, watch, settings etc. are refused by the proxy (403 `robots:true`) and opened in the user's browser instead.
- `src/proxy.rs`: FA page host throttled to >= 1 s between requests; only that host gets the cookies; picture hosts get an FA Referer. (CDN picture fetches are not throttled.)
- Session (cookies `a`, `b`, `cf_clearance`, and the sign-in window's User-Agent) lives only in `fa.json` in the data folder: never synced, never logged, never visible to page JS (`/fa/status` returns booleans and a `gen` counter).
- Cloudflare: the proxy answers 503 + `X-BR-FA: challenge`; the UI shows a tappable banner and waits (`fa.js` `untilClear`). Never bypassed, never forced open.
- FA reports registered users online; at 15,000+ background work (follow checks) pauses. Foreground browsing is not blocked.

## Files
- `ui/js/fa-parse.js` pure parsers (browse, submission, gallery, scraps, favorites, profile, folders, journals). Selectors are documented inline. `tools/fa-test.mjs` checks them (`NODE_PATH=$(npm root -g) node tools/fa-test.mjs`).
- `ui/js/fa.js` engine: queue, challenge handling, local index (`faIndex`), local likes (`faLikes`), the provider `providers.fa` (`internal: true`, so it is not in the source picker).
- `ui/js/fapage.js` the section UI (Latest/Browse/Following/Seen/Liked here; artist page with Gallery/Scraps/Favorites/Folders), banner, settings box.
- Reused as is: Gallery, Viewer, Feed, rating filter (same setting as boards), blacklist, Follows (`subs` with `p:'fa'`), pins/boards, downloads, `tagLinks`.

## Behaviour worth knowing
- Favorites and upvotes are local ("Saved in Board Roamer only, not on Fur Affinity"). Real fav/watch buttons open FA in the browser.
- Search is only over what this device has seen (`Seen` tab, tag/artist/rating/title). FA's own search opens in the browser.
- Follow checks of FA artists run unattended only if Settings > "Check followed artists in the background" is on (default off). "Check for new" always works.
- e621 artist dossier: if the artist's e621 URLs (or a saved tag link) name an FA user, a button opens that artist in the FA section and saves the e621 <-> FA link.
- Tags in the viewer: artist -> artist page; others -> `Seen` search.

## Unverified (needs Maven on Windows with real pages)
- Sign-in window, cookie capture and Cloudflare clearance reuse (cannot be tested without the site).
- Browse paging and favorites paging follow the page's own "Next" form; only page 1 fixtures exist.
- Saved pages still wanted: browse page 1 and 2, favorites p1/p2, gallery p2, multi-page search, story and music submissions, a Mature/Adult submission with comments, a Cloudflare challenge page.
