# Feed (TikTok-style tab)

Feed is the default home screen (setting `homeView`, per device; a one-time dialog `askHome()` in app.js lets people pick on first launch after the update, flag `homeAsked`): `#/feed` is the default route, and the tab order is Feed, Roam, Follows, Boards, Pools, Trail (keys 1-6). The first Follows refresh after launch waits 40 s when Feed is the landing page, so e621's queue serves the Feed first.

Modes (`feedMode`, synced): **For you** (taste), **Following** (fresh posts from followed artists only, last 30 days), **New** (site order, newest) and **Hot** (site order by score, `date:day`, widening to week then month when exhausted; Danbooru uses `order:rank`). New/Hot/Following ignore the taste model. Repeats are fine: For you only avoids the last ~400 shown posts, New/Hot only avoid duplicates within the open view. For you leans gently to newer and hotter posts (`lean()`), but a strong taste match beats it. Pull down on the first card (or tap the refresh icon) for a fresh feed; at most one per 8 s.

One post at a time, full screen, swipe (or arrow keys / J K) for the next. Route `#/feed`, second item in `NAV`, kept alive like Follows/Pools
(`KEEP_ALIVE.feed`). Opening the viewer over it (`openViewer` with a stand-in gallery) and closing it does NOT re-render the Feed: see the
`view === 'feed' && wasUp` early return in `applyRouteCore`.

## Files
- `ui/js/taste.js` – pure model (runs in node). Per tag `[liked, shown]`; lift = ln(smoothed like rate / global like rate), clipped. A post scores
  the sum of its tags' lifts times a category weight (`CAT_W`, artists 2.2) over sqrt(tag count). Counts fade with a 120-day half-life. `rate()` also
  returns novelty (share of unfamiliar tags) and the best tag (used for the "You like X" label). `interests()` = tags worth querying for.
- `ui/js/feed.js` – engine + view. Per account (credKey, so e621 and e926 share) `Model`: taste, seen ids, liked ids, learn info, follow check times,
  persisted through `kv` in `store.js` (`br1:feed:*`, per device, not synced, not in backups). Per site `src`: candidate pool, fresh follow posts, pacing, cool-down.
- Settings (synced, `store.js`): `feedSources` (sites, remembered), `feedExplore` (% wandering, default 25), `feedFollows`, `feedSyncLikes`, `feedLearn`.
  All live in the sliders icon popover at the top right of the Feed.
- `viewer.js` emits `post-like {post, on, vote}`; the Feed listens, so a heart/upvote anywhere teaches it.

## Where the signal comes from
1. Account: e621 `fav:USER` + `votedup:USER`, Danbooru `ordfav:USER`, Derpibooru `my:faves` + `my:upvotes` (needs key). First run reads up to 6 pages per query,
   then a top-up of 2 pages every 12 h. Then two pages of ordinary posts as a baseline ("shown, not liked") so lifts mean something.
   Gelbooru/Safebooru have no favorites: only hearts teach them.
2. Hearts in the Feed (and double-tap): always recorded locally; also favorite + upvote on the site when signed in and `feedSyncLikes`.
3. Soft signals: shown >700 ms = impression; lingering ~7 s (or ~90% of a video) = +0.25 like; flicked past <1.1 s = small penalty; X = strong penalty.

## What is shown
Every 3rd card (index % 3 == 1) is a fresh post (<8 days) from a followed artist when one is waiting (`followTick`, one e621 request covers 8 artists with `~`,
each artist re-checked at most every 25 min). Otherwise, with probability `feedExplore` a deliberate wander (novel, random), else a softmax pick by score.
Until the model is `ready` (4 likes, 12 shown) everything is a random popular pick.
Candidate queries: interest (1-2 liked tags, random order / random page on Danbooru) or explore (random, min score per site in `MIN_SCORE`).

## Request politeness (all in feed.js, on top of the proxy's own limiter)
`gate(src, lane)`: lanes `posts` (1.5 s apart on e621/e926, 1.2 s others), `tags` (2.5 s), `learn` (3 s), `follow` (4 s); never closer than 0.7 s across lanes; safety ceiling 120 requests per 5 min per site (category lookups stop at 70% of it). The old 20-per-5-min budget stalled the Feed for minutes once category lookups ran: do not bring it back. Errors / 429 / 5xx: 20 s cool-down doubling to 5 min.

## Loading (2.2.0)
- `warm()` downloads the pictures (video posters) of the next `feedPreload` cards (default 20; 8/20/40 in the popover), 4 at a time, nearest first. `ahead()` keeps at least preload+4 cards assembled.
- e621 new JSON: video re-encodes are under `files.video.samples/variants` (`e6alts` in providers.js); without reading them the original (30-100 MB) played. Phones take the smallest, computers 720p. Phones use `sampleSmall` (webp, about half the size).
- Only the current and next video get a source; the next one buffers ahead only if under 8 MB.
- Tags that tags.json never returns are cached as general after one asked lookup, so they are not requested forever.

## Gotchas
- e621 sends tags flat (no categories). `ensureCats()` looks up categories (one gated request, usually none thanks to the `tagc` cache) for the post about to be shown, so the artist label and category weights are right. The model counts by tag name, so learning does not depend on categories.
- Smooth `scrollTo` can be dropped by a web view when snap points interrupt it; `goTo()` finishes the scroll by hand after 650 ms.
- `fd-pop`/`fd-set` need a solid background (popover is over a photo).
- `fetchPage` builds a `Feed` per call; `pageOf` takes an existing one (needed for e621 cursor paging when reading favorites).
- DOM is windowed: slots for every card, content only within 2 of the current one.
- Not synced between devices on purpose (models are big and per-site); the settings are.

## 2.1.0 fixes
- `fill()` used to skip a round if one was already running and waited on category lookups before showing a card; with a long e621 queue (signed-in learning, follow checks) the Feed stalled after ~4 posts. Now a skipped round sets `view.again`, category lookups run in the background (`ensureCats(...).then(refreshInfo)`), `nextPost` has a 40 s timeout and the retry timer is 6 s.
- Pinch zoom (`attachZoom`): touch listeners are on the whole card (a second finger often lands on the buttons), zoom stays after release, one finger pans, the scroller is locked while zoomed, double-tap / the Reset zoom pill / moving to another card resets. ctrl+wheel zooms on desktop.
- Download button (and D) uses `ctx.savePost`; the upvote button turns solid accent when voted.
- Scrolling settles on a timer, not requestAnimationFrame (frames are not delivered to a background window).

## 2.2.0: preloading
- `AHEAD` = 14 cards lined up past the current one (was 4); pictures 3-6 cards down are prefetched with `new Image()`; `POOL_LOW` 45 / `POOL_MAX` 260 so the pool is topped up long before it runs dry (also on every card change). e621 pages are 75 posts (`pageFor`), so fewer requests carry more posts.
- `recycle()`: if a site is slow or cooling down and fewer than 5 cards are lined up, an earlier card (12+ back) is shown again, so scrolling never dead-ends. Repeats are fine by design.
- Cool-down is now 20 s doubling to 5 min (was 1 min to 15 min).
- Tag categories: `feed.noCats` stops the provider's automatic two lookups per page; the Feed asks for the categories of the next ~4 cards in one paced request (`catsNear`), and redraws their text.
- Big pool to rank from: pages are as big as each site allows (`pageFor`: e621 200, Danbooru and Gelbooru 100, Derpibooru 50), `POOL_LOW` 80, `POOL_MAX` 700. One request therefore carries hundreds of candidates, and the best of them is picked (softmax by taste, with a lean to newer/hotter). Category lookups: one paced request (<=100 tags) when the card on screen is missing categories or 70+ tags have piled up.
- Reload speed: the pool is saved per site (`feed:pool:<site>`, last 90 posts, For you only) and loaded on start, so cards show at once while a fresh batch is fetched. The first request of a session is a small one (40 posts). Pull to refresh in For you reuses the pool (new picks instantly) and fetches a fresh batch behind it; switching mode starts from scratch. Reading favorites waits 15 s, the first follow check 8 s.

## 2.3.0
- e621 posts are requested with `mode=extended` (tags grouped by category): artists are always known and the Feed makes no `tags.json` lookups. `flat` marks posts from the old/flat shape, the only ones `resolveCats` still works on. The saved pool key is `feed:pool2:` (old pools had no categories).
- Already favorited (`faved`) or liked posts are not shown, in any mode.
- Weights are stored and nudged (+/-), never recomputed; a model of 2400 favorites costs a few ms per pick. What slowed signed-in users was the favorites reading: it competed for requests and restarted from scratch if interrupted. `learnAccount` is now resumable (`learnInfo.q[query]` = pages, cursor, done): one full read ever, then 2-page top-ups. `LEARN_VERSION` bump = one re-read.
- Variety: `sameness()` subtracts from the score for artists / lead tag / characters seen in the last 14 cards; softmax temperature 0.7; interest searches skip the last 8 subjects.
- Follow suggestions: `Taste.a` counts likes per artist; at `SUGGEST_AT` (3) an unfollowed artist appears in the chip under the modes and in the settings popover, and their cards' Follow button is highlighted. Dismissed ones live in `feed:nofollow`.
- Phones show popovers as sheets: the Feed's menus (`fd-pop` / `fd-set`) need the full-width overrides at the end of `mobile.css`, and any new popover class does too.

## 2.4.0 (this replaces anything above that disagrees)
- Files: `feedengine.js` = what to show and how it is fetched (models, pacing, learning, selection, ratings helpers); `feed.js` = the screen only.
- Nothing twice: `shown` (module Set, this app session) + `model.seen` (3000, persisted) apply to For you; identity is `credKey:id` and `md5:`. New/Hot/Following only avoid duplicates inside the current list. There is no more `recycle()`.
- Organic mix: ~25% targeted interest searches at most (40 posts each), the rest broad batches; learned score is square-rooted; `sameness()` also penalizes the same heavy tags and the same search (`_q`); follow posts come at random (~1 in 4-5, never adjacent). Taste picks carry no 'You like X' label.
- Layout: on phones `body[data-view=feed]` hides `#appbar` and the Feed draws its own top bar (cloak, Following / For you / New / Hot, settings). Sites moved into the settings sheet. Tapping the Feed nav link again: toast, second tap within 3 s refreshes. Careful: `<body>` also has `data-view`, so match `a[data-view=feed]`.
- Gestures (`attachGestures`): tap = pause / open, double-tap = like, hold = post menu (Not interested, hide buttons, rate tags, share...), two fingers held = hide buttons (`.fd.clean`). `.fd.idle` fades buttons 3 s into a video (1.8 s sideways).
- `isLiked` / `isUp` / `isDown` drive the buttons (`myVote` from e621 + local `voted`). Only the video on screen may play (`hush`).
- Your tags: `Taste.r` (-2 never, -1 less, 'n' neutral = learned weight muted, 1 more, 2 love; never fades; unset = learned). `banned()` filters, `rate()`/`interests()` use it, sheet = `tagSheet` (also 'Rate its tags' per post). One toast hint at card 12 (`feed:hint:tags`).
- The per-post sheet lists every tag by category (type to filter, Add for one that is missing). `features()` stops at 70 tags for learning, so `banned()` and the rating boost in `rate()` read all of a post's tags.
- Artist page (`artistpage.js`): swipe a card left, tap an artist name, or the menu. A panel over the Feed (no search bar) with a `Gallery` of the artist's posts, Follow, count/aliases/links. Closes on swipe right, Back, Escape or tapping Feed; `view.artist` makes the Feed inactive meanwhile.
- Roam has a 'For you' route chip (`fy=1` in the hash, never the default): `SuggestFeed` in `feedengine.js` has the same `next()/done` shape as `Feed`, its own pool sharing the site's pacing (`src.pace`), uses the current source only, learns nothing from showing the grid, and is not added to the Trail.
- A post on the artist page opens `renderFeed(host, ctx, list)`: the same screen over a fixed list (`solo`). No picking, follow checks, pull-to-refresh, dwell learning or markShown; likes still count. Back / swipe right / Escape return to the grid at that post.
- The heart (button and L) only favorites. Upvoting along with it happens only for `feedDtap: 'both'` (the default double-tap).
- Double-tap: `feedDtap` (synced; fav | up | both | down), separate from the viewer's `dtap`. Only adds; `down` also advances.
- Not interested: `notInterested()` (local only, `feed:hide:<cred>`). Downvote also does it and sends -1 when signed in.
- `.fd-media` is absolutely positioned inside `.fd-stage` (inset 0, object-fit contain). Do not make it a plain grid/flex child with height 100%: tall pictures then overflow and are cut off (seen on square screens such as the Surface Duo).
- The app's floating back-to-top (`.fab`) only updates on scroll: `showView` hides it when the screen changes, and the artist page hides it on open / post open / close (late scroll events from a closing or covered artist grid are ignored in `setupTouch`).
