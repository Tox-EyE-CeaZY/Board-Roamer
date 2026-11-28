# Fur Affinity in Board Roamer

Its own section (`#/fa`, nav "Fur Affinity" (tab "FA" on phones), Settings > Fur Affinity, off by default, desktop and Android). It is not a board: Fur Affinity (FA) has no API, so it is read by scraping pages, one request a second.

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

## Watch button (2.16.1)
Maven chose (2026-11-28) a hidden background page for Watch/Unwatch even though robots.txt disallows /watch/ for automated clients. Rules kept: only on the person's tap, one artist at a time, 1.1 s before the site's own link is followed (the page's own link with its key, never a built URL), window shown only for sign-in/Cloudflare, 60 s limit. `POST /fa/act {user, watch}` + `GET /fa/act`; src/main.rs `FaWin.act`; JS `faWatchAct`. Unverified against the live site (link markup `#site-content a[href*=/watch/]`).

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
- An artist opens on their Home page (see "Artist page layout"). Journals, watchers and watching lists open on the site.

## Artist page layout
- Laid out like an FA userpage in Board Roamer's style: name block (avatar, stats, actions), tabs (Home, Gallery, Scraps, Favorites, Folders). Home has About, Gallery, Favorites and shouts on the left; journal, profile info, contact, stats and watch lists on the right (one column under 1040px). Other tabs keep a one-line name block.
- Profile pictures follow the rating switches, blacklist (veil or hide), #blur rules and "blur thumbnails". A picture with no stated rating (the profile ID one) counts as Adult.
- Gallery and Favorites each have a large preview over their thumbnails, as FA does: it starts on `#gallery-preview` / `#favorite-preview`, loads the 600px picture, and a mouse resting 300 ms on a thumbnail swaps it in.
- `featured` comes from `#gallery-preview`; the `.section-submission` picture is `profileId`.
- About keeps the bio's formatting (`richText`: bold, italic, headings, alignment, quotes, rules, links, user icons) as data, never as the page's markup. In both `richText` and `plainText`, source line breaks are spaces; only `<br>` and blocks start new lines.
- The Watch button reads "Watched" when the page's watch button points at `/unwatch/`. It still opens the site.

## Android (2.17.0)
- Java port of the desktop rules: `android/.../FaNet.java` (allow-list, 1 s gap, cookies only on the page host, Cloudflare reported, picture Referer; JVM-testable) and `Fa.java` (`/fa/*` API, session in app-private SharedPreferences, one full-screen WebView dialog for sign-in, quick check, watch-list read, and the hidden Watch/Unwatch page which only shows when sign-in or Cloudflare needs the person). MainActivity routes `/fa/*`, FA pages in `/proxy` and FA pictures in `/img`; `Net.download` accepts FA picture hosts.
- The webview gives request handlers no body, so `faPost` also puts its JSON in `?q=` (the desktop server ignores it).
- UI is the same as desktop; hover preview is mouse-only; the tab bar label is "FA".
- Unverified: never built or run on a device (no Android SDK here); only compiled against API stubs for the new files. CookieManager reading of HttpOnly cookies `a`/`b` assumed to work.

- Watch list pages (2.17.1): when the list page shows no recognisable next link, the import tries `/controls/buddylist/?page=N`, then `/controls/buddylist/N/`, one request a second, until a page adds nothing new (desktop in src/main.rs, Android in Fa.java). Still guesses: a saved copy of the real watch list page 1 and 2 (browser Ctrl+S) is needed to read the actual pager.

## Follows cache and schedule (2.18.0)
- Per-artist results already live in `subs` (thumbs, latest, newCount, checked). Pictures on FA follow cards now come from `thumbcache.js` (IndexedDB, up to ~1500 pictures, fetched two at a time 250 ms apart through `/img`), so opening Following asks the site for nothing it has.
- Background checks of FA artists (only with Settings > "Check followed artists in the background"): every 6 minutes a batch of at most 10 of the longest-unchecked artists that are older than "Check each artist about every" (30 min / hour / 3 hours, `faFollowEvery`, default hour). Opening Follows uses the same batching; "Check for new" still checks everyone, one request a second.
- Maven's view on the submissions inbox (`/msg/`): only if it all happens inside Board Roamer. Not built; a scheduled read of a robots-disallowed page is a crawler, not a click.

## Fur Affinity Feed (3.0)
The Feed has a scope switch (paw button top left, or "Feed" on the FA home). In the FA scope `enabled()` is only the `fa` provider and the booru sources are untouched: it is a source of its own and never mixed. `feedengine.js` `refillFa` fills the pool from places FA lists openly, each remembering its own page: Browse (also the New tab), galleries of followed artists and of artists the taste model keeps liking, and what those artists favorited. No search, no /msg/, no watch feed. Follows tick reads one gallery at a time (lane `follow`, marked background so it pauses when FA is busy) and keeps only ids above the last seen one per artist (`feed:fa:maxid`; FA lists carry no dates). Taste, mood, For you and probes are the boorus' own code; cards fill their submission page when they come on screen (tags, description, original), so learning improves as you scroll. No Hot tab in this scope.

## Menus and the pop-out window (3.2.0)
- Right-click / long-press on the Fur Affinity screens: one listener in `renderFa` (`bindFaMenus` in `ui/js/fapage.js`). Elements carry `data-fa-user` (artist), `data-url` (link); picture buttons are looked up in `menuPost`. Menus come from `faUserMenu`, `linkMenu`, `tagMenu` (FA branch) and `postMenu` in `ui/js/menus.js`. The viewer uses the same through `hooks.faUserMenu` / `hooks.linkMenu`.
- Desktop pop-out (sign-in, quick check, Watch) is frameless off macOS. `src/fa_chrome.js` is injected into every page of that window (title bar, frame, resize edges) and talks to the app through a filtered ipc handler (`fa:drag|min|max|shut|resize:*` only, since the page is someone else's site). Android: the `Win` dialog in `Fa.java` has the same bar.
- The old CloseRequested arm closed the main window whichever window asked; it now checks the window id.

## Diagnostics log (3.3.1)
Settings > Fur Affinity > Diagnostics shows what the verification flow did, with Copy (and Share on Android), Refresh and Clear. App lines come from `faLog` in `ui/js/fa.js` (kept in `faLog` kv, 300 lines); native lines from `/fa/log` (`fa::log` in `src/fa.rs`, `FaNet.log` on Android, 400 lines, in memory). Lines: check detected/passed/still blocked, Cloudflare answers from the proxy, window opened, each page the window showed (path, check showing, whether the a, b and cf_clearance cookies were present as booleans), window finished or closed, watch results. Never cookie values, passwords or query strings.
