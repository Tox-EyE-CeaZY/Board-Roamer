import { copyText, pretty } from './util.js';
import { S, setS, boards, postKey, tagc, emit } from './store.js';
import { getProvider } from './providers.js';
import { toast, promptText } from './ui.js';
import { downloadMany, openExternal, savePost } from './actions.js';
import { isAndroid, native } from './platform.js';

/**
 * Context-menu builders shared by the gallery, viewer, filmstrip, boards, pools and follows views.
 * The app wires its navigation functions into `M` once at start-up.
 */
export const M = {
  tagAction: () => {}, // (tag, 'only'|'add'|'exclude', provId)
  toggleStar: () => {},
  toggleFollow: () => {},
  isStarred: () => false,
  isFollowing: () => false,
  enterPool: () => {},
  openPoolPage: () => {},
  readPool: () => {},
  pin: () => {}, // (posts, x, y)
  share: () => {},
};

function boardSub(posts) {
  const list = boards.pins();
  return [
    ...list.map((b) => {
      const have = posts.filter((p) => boards.has(b.id, postKey(p))).length;
      return {
        label: `${b.name}  ·  ${b.posts.length}`, checked: have === posts.length,
        run: () => {
          if (have === posts.length) (boards.removePosts(b.id, posts.map(postKey)), toast(`Removed from ${b.name}`));
          else toast(`Pinned ${boards.add(b.id, posts)} to ${b.name}`);
          emit('pins-changed');
        },
      };
    }),
    list.length && { sep: true },
    {
      label: 'New board…', icon: 'plus',
      run: async () => {
        const n = await promptText('Name your board', '', 'e.g. Wallpapers, To read, Reference…');
        if (!n) return;
        const b = boards.create(n, 'pins');
        toast(`Pinned ${boards.add(b.id, posts)} to “${b.name}”`);
        emit('pins-changed');
      },
    },
  ];
}

export function blacklistAdd(rule) {
  const list = S('blacklist') || [];
  if (list.includes(rule)) return toast('Already on your blacklist', { ms: 1400 });
  setS('blacklist', [...list, rule]);
  toast(`Blacklisted “${pretty(rule)}”`, { ms: 1800 });
}

/** Right-click on a post (tile, filmstrip thumb, viewer picture). */
export function postMenu(post, { gallery, open, viewer } = {}) {
  if (!post) return [];
  const prov = getProvider(post.provider);
  const sel = gallery?.selectMode && gallery.sel.size > 1 && gallery.sel.has(postKey(post)) ? gallery.selected() : null;
  const items = [];
  if (sel) {
    items.push(
      { header: `${sel.length} selected` },
      { label: `Pin ${sel.length} to board`, icon: 'pin', sub: boardSub(sel) },
      { label: `Download ${sel.length}`, icon: 'download', run: () => downloadMany(sel) },
      { label: 'Clear selection', icon: 'close', run: () => gallery.clearSel() },
      { sep: true },
    );
  }
  if (open) items.push({ label: 'Open', icon: 'eye', kbd: 'Enter', run: open });
  items.push(
    { label: 'Open on site', icon: 'external', kbd: 'O', run: () => openExternal(post.url) },
    { label: 'Copy post link', icon: 'link', kbd: 'C', run: () => (copyText(post.url), toast('Post link copied', { ms: 1200 })) },
    { label: 'Share link…', icon: 'share', run: () => M.share(post) },
    isAndroid() && { label: 'Share image…', icon: 'share', run: () => native.shareFile(post.sample || post.full, `${post.provider}_${post.id}.${post.ext}`) },
    { label: 'Copy image address', icon: 'copy', run: () => (copyText(post.full), toast('Image address copied', { ms: 1200 })) },
    { label: 'Copy tags', icon: 'tag', run: () => (copyText(Object.values(post.tags).flat().join(' ')), toast('Tags copied', { ms: 1200 })) },
    { sep: true },
    { label: 'Save to Downloads', icon: 'download', kbd: 'S', run: () => (viewer?.download ? viewer.download() : savePost(post).then(() => toast('Saved to Downloads\\Board Roamer', { ms: 2200 })).catch((e) => toast(e.message, { kind: 'err' }))) },
    { label: 'Pin to board', icon: 'pin', kbd: 'B', sub: boardSub([post]) },
  );
  if (prov.fav && viewer) items.push({ label: post.faved ? 'Remove favorite' : 'Favorite', icon: 'heart', kbd: 'V', run: () => viewer.toggleFav() });
  items.push({ sep: true });
  for (const a of post.artists.slice(0, 3)) {
    const fol = M.isFollowing(a, post.provider);
    items.push(
      { label: `More from ${pretty(a)}`, icon: 'user', run: () => M.tagAction(a, 'only', post.provider) },
      { label: fol ? `Unfollow ${pretty(a)}` : `Follow ${pretty(a)}`, icon: fol ? 'bellOn' : 'bell', run: () => M.toggleFollow(a, post.provider) },
    );
  }
  const rel = [];
  if (post.parent) rel.push({ label: `Parent  #${post.parent}`, icon: 'up', run: () => M.tagAction('parent:' + post.parent, 'only', post.provider) });
  if (post.children?.length || post.hasChildren) rel.push({ label: 'Children', icon: 'down', run: () => M.tagAction('parent:' + post.id, 'only', post.provider) });
  for (const id of post.pools || []) {
    rel.push({ label: `Pool #${id}`, icon: post.isComic ? 'book' : 'pool', sub: [
      { label: 'Browse pool', icon: 'pool', run: () => M.openPoolPage(id, post.provider) },
      { label: 'Step through in viewer', icon: 'eye', run: () => M.enterPool(id, post.id, post.provider) },
      post.isComic && { label: 'Read as comic', icon: 'book', run: () => M.readPool(id, post.id, post.provider) },
    ] });
  }
  if (rel.length) items.push({ sep: true }, ...rel);
  if (post.artists[0]) {
    items.push({ sep: true }, { label: `Blacklist ${pretty(post.artists[0])}`, icon: 'cloak', danger: true, run: () => blacklistAdd(post.artists[0]) });
  }
  return items;
}

/** Right-click on a tag (viewer list, search chip, dossier). */
export function tagMenu(tag, cat, provId) {
  if (!tag) return [];
  const prov = getProvider(provId);
  const artist = cat === 'artist' || tagc.get(prov.id, tag)?.cat === 'artist';
  const meta = tag.includes(':');
  const on = artist ? M.isFollowing(tag, provId) : M.isStarred(tag, provId);
  return [
    { header: pretty(tag) },
    { label: 'Search only this', icon: 'search', run: () => M.tagAction(tag, 'only', provId) },
    { label: 'Add to search', icon: 'plus', run: () => M.tagAction(tag, 'add', provId) },
    { label: 'Exclude from search', icon: 'minus', run: () => M.tagAction(tag, 'exclude', provId) },
    !meta && { sep: true },
    !meta && (artist
      ? { label: on ? 'Unfollow artist' : 'Follow artist', icon: on ? 'bellOn' : 'bell', run: () => M.toggleFollow(tag, provId) }
      : { label: on ? 'Unstar' : 'Star this tag', icon: 'star', run: () => M.toggleStar(tag, provId) }),
    { sep: true },
    { label: 'Copy tag', icon: 'copy', run: () => (copyText(tag), toast('Copied', { ms: 900 })) },
    !meta && { label: `Open “${pretty(tag)}” on site`, icon: 'external', run: () => openExternal(`${prov.web}/wiki_pages/show_or_new?title=${encodeURIComponent(tag)}`) },
    !meta && { sep: true },
    !meta && { label: 'Add to blacklist', icon: 'cloak', danger: true, run: () => blacklistAdd(tag) },
  ];
}
