# Local files, folders, and the viewer fixes (1.8.0)

Notes on what the code does, so the next change doesn't have to rediscover it.

## Local (`ui/js/local.js`, `src/local.rs`, `android/.../Local.java`)
- Every device answers the same routes: `/local/list`, `/local/file` (Range), `/local/thumb`; settings use `/local/config` (changes ride on
  the query: `?add=<path>&name=`, `?remove=<id>`, `?share=1|0`) and `/local/dirs` (the in-app folder picker). A request names a root id and a
  path *inside* it; `resolve()` refuses anything that canonicalises outside the root.
- Another device is `/remote/<id>/local/...`: the desktop (`local::remote`) and the phone (`Local.remote`) forward it with
  `Authorization: Bearer <pairing code>`. The desktop hub lists phones that share (`/sync/device` announce, `/sync/devices`); a phone
  runs a tiny `ServerSocket` (port 4623+) and `ShareService` (foreground service, `dataSync`) keeps it alive; `BootReceiver` restores it.
  The hub url + code are persisted in the phone's prefs so sharing works after a reboot.
- `list` includes `meta` read back from the file: XMP (`meta.rs::read`, `MetaRead.java`) from the head of images, the tail of MP4/WebM, or
  a `.xmp` sidecar; WebM/MKV use the `BOARDROAMER_JSON` SimpleTag. Sizes + meta are cached per file (path+size+mtime), on disk on Android.
  Older downloads fall back to their file name (`e6_<id>_<artist>.ext`) in `local.js::fromName`.
- Android listing runs on an 8-thread pool; thumbnails use `ThumbnailUtils` first. Needs "All files access".
- Local files reuse `Gallery` and the viewer through a stand-in provider (`providers.local`, hidden from the source picker). Tags you
  add live in `localMeta` (per device, not synced). The folder grid sits *inside* the gallery's scroller; `Gallery._off()` shifts the
  tile maths by its height.

## Folders (`ui/js/folders.js`, `store.js` `folders`)
`board.folder` / `library item.folder (+folderT)`; folders sync as a list (`mergeFolders`, tombstone map `f`). Deleting moves items out.

## Viewer (Android) fixes
- Pinch release: the drag record is restarted from the finger that stays down (`_pup`), otherwise it panned by the distance between
  the two fingers and the picture darted sideways.
- Flashing while swiping: the original is decoded off to the side then swapped in (`_makeMedia`), and on touch only once you zoom;
  originals are not preloaded on touch; the backdrop changes only after its image is decoded (`_setBg`).

## Multi-site boards (`multi.js`, `sources.js`)
`board.sources = [{provider, terms}]` are the extra sites (the primary is `board.provider/terms`). `#/roam?...&mb=<boardId>` runs a `MultiFeed` (same
`next()/done` interface as `Feed`). Merge: newest-first by date, each site refilled only when its buffer is empty; other orders take turns.
Duplicates: source/cross-link keys (`srcKeys`, `postRef`), then a dHash of the thumbnails for same-shape same-artist posts of different sites.
`better()` picks the shown copy (clearly bigger wins, else `RANK`: e621 first, Derpibooru last); the tile object is promoted in place and gets
`also`. `tagLinks` (store.js, synced) remembers equivalent tags per site. Seen/new tracking and the 30-minute check use the primary site only.
Testing in a headless Edge against the real app: it auto-syncs with the PC hub, so anything seeded there lands in the real library.

## Derpibooru comics as pools
A pool is a `comic:<title>` tag (`pmPoolId`); pages are the images with that tag by id ascending. `pool()`, `poolPosts()`, `poolsSearch()` (tags
search for Biggest, a walk over the newest comic pages for Recently updated), `poolCovers()` (cover art tag, else a page already seen).
