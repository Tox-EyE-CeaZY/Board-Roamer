# Tabs (computers first, phones get a switcher)

Written while adding the tab system and the "sections in their own tab" setting. Notes on what the code does, so the
next change doesn't have to rediscover it.

## Files
- `ui/js/tabs.js` – owns the list of tabs (`localStorage` key `br1:tabs`), the tab strip, the phone card switcher and the
  keyboard shortcuts (Ctrl+T / W / Tab / PageUp / PageDown / Shift+T). It knows nothing about the app: `app.js` hands it
  hooks in `setupTabs(stripEl, { titleFor, newHash, snapshot, show })`.
- `ui/js/app.js` – supplies those hooks. `snapshotView()` captures scroll + (for roam) the search, loaded posts and
  feed; `showTab()` navigates and `restoreRoam()` puts the results back without a new search. `noteTabRoute()` runs after
  every `applyRoute()` so the active tab always mirrors where you are.
- `ui/js/settings.js` – Settings > Look: Tabs (off / auto / always), reopen tabs, sections-in-own-tab chips, follows freshness.
- `ui/js/follows.js`, `boards.js`, `pools.js`, `library.js`, `trail.js`, `menus.js` – "Open in new tab" menu items and
  `data-hash` on cards (that is what middle-click / Ctrl+click read).

## Settings (`store.js` DEFAULTS)
| key | values | meaning |
| --- | --- | --- |
| `tabs` | `off` / `auto` / `always` | auto shows the bar once a second tab exists |
| `restoreTabs` | bool | reopen last session's tabs |
| `mainTab` | bool | pinned Main tab, see below |
| `followsFresh` | minutes (2 / 10 / 30) | how old a follow's last check may be before Follows re-checks it on view |

## The pinned Main tab (replaces the earlier per-section tabs)
Setting `mainTab` (default on, computers only, needs tabs on). The first tab is Main: it cannot be closed or dragged, nothing can be
put in front of it, and in the title bar it takes the place of the view label (`.tb-ctx` is hidden once the strip shows).
Routing lives in `routeToTab()` in `app.js`; everything navigates through `setHash()`:
- A **page** (`#/roam`, `#/boards`, `#/follows`, `#/pools`, `#/trail`, no search): handled in Main. From a content tab, rail clicks and
  number keys switch to Main and navigate it there.
- **Content** (a board, a pool, a search) opened while Main is on Boards / Follows / Pools / Trail: opens in a new foreground tab,
  so Main never becomes a back-button trail. Right-click "Open in new tab" opens in the background instead.
- Main on **Roam** searches in place (typing a search is not "opening content"). A tab that is not Main navigates itself.

`tabs.js` exports `mainActive()` and `focusMain()` for this; the app tells it whether Main is on with the `mainOn` hook.

## Keeping Follows current
- `refreshAll()` only re-checks follows older than `followsFresh` minutes, one at a time (the proxy paces them).
- It runs: 4.5 s after boot, every 30 min, whenever the Follows view renders (so switching to the Follows tab
  re-renders and catches up), and on window `focus` while the Follows view is on screen.
- The Follows view repaints from the `subs` event, so a Follows tab that is on screen updates live.

## Gotchas
- Source files are CRLF (some lines LF). Edit tools that match exact text must tolerate both.
- A roam feed that finishes loading a page after you left its tab stashes it in `feed._stash`; `restoreRoam` merges it back.
- `tabs.js` persists only `{id, hash, title, thumb}`; snapshots (`snap`) live in memory and are lost on restart.
- The tab strip is hidden on phones via CSS (`html.phone .tabstrip`); phones use the count button in the app bar.
- Not run in a live window yet: only syntax-checked with `node --check`. Worth a click-through of the section tabs.

## Releases
A tag `vX.Y.Z` pushed to origin runs `.github/workflows/build.yml`, which sets the version from the tag, builds every
platform and publishes the GitHub release the in-app updater reads. Keep `Cargo.toml` in step with the tag.

## Back history is per tab
The WebView has one history stack for every tab, so history entries are stamped `{ n, t: tabId }` (`n` = depth, for the Android
Back button). `hashchange` in `app.js` compares `history.state.t` with `activeTabId()`: an entry from another tab means this tab's
trail ran out, so `backOut()` closes the tab and shows the one in `tab.from` (the tab it was opened from). Main never closes; it
just restamps the entry. Android's system Back does the same when `navDepth` is 0 (`canBackOut()`).

## Notifications (`notify.js`)
`announce(kind, names)` is called at the end of `refreshAll` (follows), `refreshBoards` (live boards, `boards.js`) and `refreshLib`
(pools) when a check found *more* new items than before. Settings: `notify`, `notifyFollows/Boards/Pools`, `notifyNames`. It skips
when the window is focused, batches kinds arriving within 2.5 s, and sends only generic text (artist names only with
`notifyNames`). Desktop: `POST /notify` -> `os::notify` (PowerShell toast with its own app id / `osascript` / `notify-send`).
Android: `AndroidBridge.notify` (private lock-screen version, `POST_NOTIFICATIONS` asked at runtime).
Android also works with the app closed, with no Firebase: `watch.js` sends a watch list (the exact request per follow / live
board / pool plus what is already seen) through `AndroidBridge.setWatch`; `Watch.java` stores it and schedules a persisted 30-minute
`JobScheduler` job (`WatchJob`), which asks the sites via `Net.api`, remembers what it already announced, and posts through
`Notifier`. It stays quiet while the app is on screen (`Watch.visible`), and `announce()` is a no-op on Android so nothing doubles.
Doze/battery savers can delay the job; it is not instant. Live boards store `seenId/latestId/newCount/checked`.

## Where the strip lives
On Windows and Linux the custom title bar hosts the strip: `initTitlebar()` moves `#tabs` into `.tb-tabs`, to the right of the
view label, and adds `html.tabs-in-bar`. Dragging the window works on the left block and the filler after the tabs, not on the
tabs. macOS keeps its native frame and phones have no strip, so there it stays in `.main` / the count button.

## Pools and Follows stay alive (`mountPane()` in `app.js`)
`#v-other` holds panes (`.pane`, `display: contents`). Pools and Follows each get their own pane per tab (Pools also per site,
see `KEEP_ALIVE`); every other view renders into the shared scratch pane. Opening a pool / an artist / a board hides the kept pane
instead of replacing it, so coming back (Back, the pool's arrow, the bottom bar) shows it as it was: loaded pages, "Load more"
progress, scroll (saved in `pane._scroll`, since a hidden pane loses it). Applying the same view again while it is on screen still
re-renders. A kept pane stays connected, so its `root.contains(...)` listeners keep updating it in the background. At most 4 kept.
Render functions must not treat `root` as the scroller: use `root.closest('.view')` (see `follows.js`).
