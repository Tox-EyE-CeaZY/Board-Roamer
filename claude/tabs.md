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
| `tabSections` | array of `boards` `follows` `pools` `trail` | those sections get a tab of their own. Ignored on phones and when tabs are off |
| `followsFresh` | minutes (2 / 10 / 30) | how old a follow's last check may be before Follows re-checks it on view |

## Sections in their own tab – how routing works
Everything that navigates goes through `setHash(hash, fresh)` in `app.js` (`go()`, `navigateRoam()`, `runSmart`,
trail entries, pool reading). The side rail has a click handler that calls `routeToTab`. `routeToTab`:
1. Not a computer, tabs off or `tabSections` empty -> plain `location.hash = ...`.
2. Target is a tab-owned section and you are not already in it -> `focusTab` (switch to the existing tab, else open one).
   Boards and a single board count as one group (`NAV_OF`: board->boards, pool->pools).
3. You are in a tab-owned section and the target is something else:
   - `fresh` (an artist card, a board run, a trail entry: a result) -> opens a **new** tab so the section tab stays put.
   - otherwise (rail click on Roam, number keys) -> switch to a tab that is not section-owned, or open one.

`tabs.focus(match, hash)` is the helper that finds the tab by predicate over its hash.

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
