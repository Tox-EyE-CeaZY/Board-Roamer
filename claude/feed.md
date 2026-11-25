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
One request at a time per site, >= 2.4 s apart (e621/e926) or 1.8 s, <= 20 per 5 min, 40 posts per request, refill only when the pool is under 18 and the
Feed is on screen and visible. Errors / 429 / 5xx put the site on a 1, 2, 4 ... 15 min cool-down (`src.cool`). Media is only loaded for the card on screen and the next two.

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
