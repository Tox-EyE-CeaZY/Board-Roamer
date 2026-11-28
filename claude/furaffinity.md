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
- Names typed into "Open an artist" are normalized (`faName`: "barbie wire" -> barbiewire); a 400/404 shows a "no such artist" state. "On e621?" asks which tag when unsure (`pickE621Artist`) and saves the pair.
- Any Fur Affinity link inside the app opens in the section; e621 posts with an FA source get a jump button in the viewer.
- Tags in the viewer: artist -> artist page; others -> `Seen` search.

## Unverified (needs Maven on Windows with real pages)
- Sign-in window, cookie capture and Cloudflare clearance reuse (cannot be tested without the site).
- Browse paging and favorites paging follow the page's own "Next" form; only page 1 fixtures exist.
- Saved pages still wanted: browse page 1 and 2, favorites p1/p2, gallery p2, multi-page search, story and music submissions, a Mature/Adult submission with comments, a Cloudflare challenge page.

## 2.15.1 additions
- Pictures load through the local proxy (own Referer, one pooled connection agent); tiles use the thumbnail the page listed.
- Writing and music: tiles without a cover become text cards; the viewer shows a reading page (`fadoc.js`: the page's own text, or a .txt/.rtf file; .pdf/.docx open on the site) or an audio player. The story-body and audio selectors are guesses: a saved story page and song page are still needed to confirm them.
- The reading page scrolls with wheel, touch and keys (up/down, page keys, space, home/end); PDF stories show in the webview's own PDF viewer through the proxy (Windows; unverified), with the site button underneath.
- The front page has no next page: after the list, "Load more" continues through Browse, keeping the section's kind of work.
- The Fur Affinity button sits above the source dial in the rail. Layout and tile-size controls are shared with the boards.
- Following > "Import my watch list": on a tap, the Fur Affinity window opens the person's own watch list page (signing in there if asked), reads the names once, and closes; the person confirms the list before anything is followed. Pasting the page is the fallback. No background requests.
- The watch-list import follows the list's own next-page link (1.1 s apart, up to 100 pages, stops on a repeat or a page with nothing new). The next-link detection is a guess (no real multi-page page saved yet): a saved page 2 or the list's pager markup would confirm it.
- Profile tab (default on an artist): bio, info and contact, featured, latest submissions and favorites, shouts (markup unseen, best effort). Journals, watchers and watching lists open on the site.
