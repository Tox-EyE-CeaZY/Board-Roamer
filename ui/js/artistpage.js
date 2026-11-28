/* An artist's page, slid in over the Feed: who they are, a Follow button and their posts, newest first. No search bar.
   Swipe the page to the right (or press Back) to return to the post you came from. */
import { h, pretty, fmtNum } from './util.js';
import { icon } from './icons.js';
import { S, subs, tagc, tagLinks } from './store.js';
import { faUserIn, faLink, faSupported } from './fa.js';
import { getProvider, Feed } from './providers.js';
import { Gallery } from './gallery.js';
import { follow } from './follows.js';
import { quickPin } from './pins.js';
import { openExternal } from './actions.js';
import { onBack } from './platform.js';

const viewerOpen = () => { const v = document.getElementById('viewer'); return !!v && !v.hidden && v.classList.contains('in'); };
const covered = () => viewerOpen() || !!document.querySelector('.sheet-back, .pop, .dlg-back, .ctxm');

/**
 * @param host   the element to cover
 * @param ctx    the app's view context (openViewer, go, roamHash)
 * @param opts   provId, names (the post's artists), name (the one to show first), onClose, onFollow,
 *               openReel(host, list): the Feed's own screen over a fixed list, which is how a post opens here
 * @returns      { close() }
 */
export function openArtistPage(host, ctx, { provId, names, name = names[0], onClose, onFollow, openReel }) {
  const base = getProvider(provId);
  let prov = base;
  let current = name, gal = null, feed = null, run = 0, closed = false, reel = null;
  let more = () => Promise.resolve(); // the next page of the artist shown
  const title = h('div', { class: 'fd-ap-title' });
  const body = h('div', { class: 'fd-ap-body' });
  const page = h('div', { class: 'fd-artist' },
    h('div', { class: 'fd-ap-head' }, h('button', { class: 'fd-ib', title: 'Back', 'aria-label': 'Back', html: icon('left', 20), onclick: () => close() }), title),
    body);

  const hideTop = () => { const b = document.querySelector(".fab"); if (b) b.hidden = true; }; // the app's "back to top": it only follows scrolling
  /**
   * `fa`: show the artist's Fur Affinity gallery instead ({ user, folder?: { id, slug, name } }). It is the same page: the
   * same grid and the same way a post opens, with the artist's Fur Affinity folders as chips above the posts.
   */
  async function load(who, fa = null) {
    hideTop();
    const mine = ++run;
    prov = fa ? getProvider('fa') : base;
    if (!fa) current = who;
    title.replaceChildren(h('b', {}, pretty(who)), h('small', {}, prov.name + (fa?.folder ? ' · ' + (fa.folder.name || 'folder') : '')));
    const count = h('span', { class: 'fd-ap-count' });
    const about = h('div', { class: 'fd-ap-about' });
    const folderRow = h('div', { class: 'fd-ap-others fd-ap-folders', hidden: true });
    const followBtn = h('button', { class: 'btn', onclick: () => { follow(who, prov.id); paintFollow(); onFollow?.(); } });
    const paintFollow = () => {
      const on = !!subs.find(prov.credKey, who);
      followBtn.classList.toggle('primary', !on);
      followBtn.innerHTML = icon(on ? 'bellOn' : 'bell', 15) + `<span>${on ? 'Following' : 'Follow'}</span>`;
    };
    paintFollow();
    const info = h('div', { class: 'fd-ap-info' },
      !fa && names.length > 1 ? h('div', { class: 'fd-ap-others' }, names.map((n) => h('button', { class: 'fd-chip' + (n === who ? ' on' : ''), onclick: () => n !== current && load(n) }, pretty(n)))) : null,
      h('div', { class: 'fd-ap-name' }, h('h2', {}, pretty(who)), count),
      about,
      h('div', { class: 'fd-btnrow' }, followBtn,
        fa ? h('button', { class: 'btn', html: icon('left', 15) + `<span>Back to ${base.name}</span>`, onclick: () => load(current) })
          : h('button', { class: 'btn', html: icon('search', 15) + '<span>Open in search</span>', onclick: () => ctx.go(ctx.roamHash([{ t: who, op: '+' }], null, prov.id)) }),
        fa ? h('button', { class: 'btn', html: icon('external', 15) + '<span>Open on Fur Affinity</span>', onclick: () => ctx.go(`#/fa/user/${encodeURIComponent(fa.user)}`) }) : null),
      folderRow);

    const scroller = h('div', { class: 'gal' });
    body.replaceChildren(scroller);
    scroller.append(info);
    const status = h('div', { class: 'fd-ap-status' }, 'Loading posts…');
    gal = new Gallery(scroller, {
      onOpen: (vi) => openAt(vi, who),
      onNeedMore: () => more(),
      onPin: (ps) => quickPin(ps),
      onOpenSite: (p) => openExternal(p.url, p.provider === 'fa'),
      onSelect: () => {},
    });
    gal.setFoot(status);
    feed = new Feed(prov, [{ t: who, op: '+' }], { order: '', score: 0, ratings: S('filters').ratings, media: '', shape: '', age: '' });
    if (fa) feed.fa = fa.folder ? { kind: 'folder', user: fa.user, folder: { id: fa.folder.id, slug: fa.folder.slug || '' } } : { kind: 'gallery', user: fa.user };
    let fetching = null;
    /** The next page; asked again while one is on its way, it hands back the same wait. */
    more = () => {
      if (!feed || feed.done || mine !== run) return Promise.resolve();
      return (fetching ||= fetchMore().finally(() => (fetching = null)));
    };
    const fetchMore = async () => {
      try {
        const posts = await feed.next();
        if (mine !== run || closed) return;
        gal.append(posts);
        status.textContent = feed.done ? (gal.length ? 'That is everything' : 'No posts to show') : '';
        // Fur Affinity: the artist's folders, as soon as their first page has said what they are
        const groups = fa && feed.pageInfo?.folders;
        if (groups?.length && folderRow.hidden) {
          const all = groups.flatMap((g) => g.folders).filter((f) => f.id);
          folderRow.replaceChildren(h('button', { class: 'fd-chip' + (fa.folder ? '' : ' on'), onclick: () => load(who, { user: fa.user }) }, 'All'),
            ...all.map((f) => h('button', { class: 'fd-chip' + (fa.folder?.id === f.id ? ' on' : ''), title: `${f.count || ''} submissions`.trim(), onclick: () => load(who, { user: fa.user, folder: f }) }, f.name)));
          folderRow.hidden = !all.length;
        }
      } catch (e) {
        status.replaceChildren(h('span', {}, e.message + ' '), h('button', { class: 'btn', onclick: () => ((status.textContent = 'Loading posts…'), more()) }, 'Try again'));
      }
    };
    more();

    // post count, other names and links, as they arrive
    try {
      if (fa) return;
      let tag = tagc.get(prov.id, who);
      if (!tag?.count && prov.tagInfo) {
        tag = await prov.tagInfo(who);
        if (tag) tagc.set(prov.id, who, tag);
      }
      if (mine !== run) return;
      if (tag?.count) count.textContent = `${fmtNum(tag.count)} posts`;
      const a = prov.artist ? await prov.artist(who) : null;
      if (mine !== run || !a) return;
      const links = (a.urls || []).filter((u) => /^https?:/.test(u)).slice(0, 10);
      const faOn = faSupported() && S('faOn');
      const faUser = faOn ? faUserIn(a.urls) || tagLinks.suggest(prov.credKey, who, 'fa') || '' : '';
      const openLink = (u) => {
        const l = faOn && faLink(u);
        if (l?.user) return (tagLinks.link([{ key: prov.credKey, tag: who }, { key: 'fa', tag: l.user }]), ctx.go(l.hash)); // a Fur Affinity link opens in the app
        openExternal(u);
      };
      about.replaceChildren(
        a.other?.length ? h('p', {}, 'Also known as ', a.other.slice(0, 6).map(pretty).join(', ')) : null,
        a.group ? h('p', {}, 'Group: ', pretty(a.group)) : null,
        links.length ? h('div', { class: 'fd-ap-links' }, links.map((u) => h('button', { title: u, onclick: () => openLink(u) }, u.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]))) : null,
        faUser ? h('div', { class: 'fd-btnrow' }, h('button', { class: 'btn', title: 'Their Fur Affinity gallery and folders, in this same view', html: icon('paw', 15) + `<span>${pretty(faUser)} on Fur Affinity</span>`, onclick: () => (tagLinks.link([{ key: prov.credKey, tag: who }, { key: 'fa', tag: faUser }]), load(faUser, { user: faUser })) }),
          h('button', { class: 'btn', html: icon('external', 15) + '<span>Open the full page</span>', onclick: () => ctx.go(`#/fa/user/${encodeURIComponent(faUser)}`) })) : null);
    } catch {
      /* the posts matter more than the notes about them */
    }
  }

  /** A post opens the way the Feed shows posts: full screen, swipe for the next of this artist's, in order. */
  function openAt(vi, who) {
    if (reel) return;
    const el = h('div', { class: 'fd-reel' });
    page.append(el);
    hideTop();
    const g = gal;
    const screen = openReel(el, { title: pretty(who), start: vi, posts: () => g.viewList(), more: () => more(), onClose: () => closeReel() });
    const off = onBack(() => (covered() ? false : (closeReel(), true)));
    reel = { el, screen, off, gal: g };
  }
  /** Back to the grid, at the post you were on. */
  function closeReel() {
    if (!reel) return;
    const { el, screen, off, gal: g } = reel;
    reel = null;
    const at = screen.index();
    hideTop();
    off();
    screen.destroy();
    el.remove();
    const item = g.itemIndexOfView(at);
    if (item >= 0) g.scrollTo(item);
  }

  function close() {
    if (closed) return;
    closeReel();
    hideTop();
    closed = true;
    run++;
    offBack();
    removeEventListener('keydown', onKey, true);
    removeEventListener('hashchange', onHash);
    page.classList.remove('in');
    setTimeout(() => (page.remove(), hideTop()), 300); // its grid can still report a scroll while sliding out
    onClose?.();
  }
  const offBack = onBack(() => (covered() ? false : (close(), true)));
  const onKey = (e) => {
    if ((e.key === 'Escape' || e.key === 'ArrowLeft') && !covered() && document.body.dataset.view === 'feed') (e.preventDefault(), e.stopPropagation(), reel ? closeReel() : close());
  };
  addEventListener('keydown', onKey, true);
  const onHash = () => setTimeout(() => document.body.dataset.view !== 'feed' && close(), 0); // off to a search: do not leave it lying open
  addEventListener('hashchange', onHash);

  let start = null;
  page.addEventListener('touchstart', (e) => { start = !reel && e.touches.length === 1 && !e.target.closest('.fd-ap-others') ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
  page.addEventListener('touchend', (e) => {
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y;
    start = null;
    if (dx > 70 && dx > Math.abs(dy) * 1.7) close();
  }, { passive: true });

  host.append(page);
  load(current);
  setTimeout(() => page.classList.add('in'), 20);
  return { close };
}
