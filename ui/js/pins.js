import { h } from './util.js';
import { icon } from './icons.js';
import { boards, postKey, emit, on } from './store.js';
import { popover, toast } from './ui.js';

/** Content for a "pin to board" menu. Works for one post or a whole selection. */
export function pinContent(posts, { after } = {}) {
  const keys = posts.map(postKey);
  const root = h('div', { class: 'pinmenu' });
  const render = () => {
    const list = boards.pins();
    const rows = list.map((b) => {
      const have = keys.filter((k) => boards.has(b.id, k)).length;
      const state = have === 0 ? '' : have === keys.length ? 'all' : 'some';
      return h('button', {
        class: 'pm-row ' + state, style: `--bh:${b.hue}`,
        onclick: () => {
          if (state === 'all') {
            boards.removePosts(b.id, keys);
            toast(`Removed from ${b.name}`);
          } else {
            const n = boards.add(b.id, posts);
            toast(n ? `Pinned ${n} to ${b.name}` : 'Already pinned');
          }
          emit('pins-changed');
          render();
          after?.();
        },
      }, h('i', { class: 'pm-check', html: state === 'all' ? icon('check', 13) : state === 'some' ? icon('minus', 13) : '' }),
        h('span', { class: 'pm-name' }, b.name), h('span', { class: 'pm-n' }, b.posts.length));
    });
    const input = h('input', { class: 'input', placeholder: 'New board…', spellcheck: 'false' });
    const make = () => {
      const name = input.value.trim();
      if (!name) return input.focus();
      const b = boards.create(name, 'pins');
      boards.add(b.id, posts);
      toast(`Pinned to new board “${b.name}”`);
      emit('pins-changed');
      render();
      after?.();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') make(); });
    root.replaceChildren(
      h('div', { class: 'pm-head' }, h('b', {}, posts.length > 1 ? `Pin ${posts.length} posts` : 'Pin to board')),
      h('div', { class: 'pm-list' }, rows.length ? rows : h('div', { class: 'pm-empty' }, 'No boards yet — name your first one below.')),
      h('div', { class: 'pm-new' }, input, h('button', { class: 'btn primary', onclick: make, html: icon('plus', 16) })),
    );
  };
  render();
  return root;
}

/** One tap: pin to (or unpin from) the built-in Pins board. The toast offers "Move…" to pick another board. */
export function quickPin(posts) {
  const box = boards.inbox();
  const keys = posts.map(postKey);
  const all = keys.every((k) => boards.has(box.id, k));
  if (all) {
    boards.removePosts(box.id, keys);
    toast(posts.length > 1 ? `Removed ${posts.length} from Pins` : 'Unpinned', { ms: 2400, action: { label: 'Undo', run: () => (boards.add(box.id, posts), emit('pins-changed')) } });
  } else {
    const n = boards.add(box.id, posts);
    toast(`Pinned${n > 1 ? ' ' + n : ''} to Pins`, { ms: 3200, action: { label: 'Move…', run: () => pinPopover(document.getElementById('toasts'), posts) } });
  }
  emit('pins-changed');
}

export function pinPopover(anchor, posts) {
  const el = popover(anchor, pinContent(posts, { after: () => el.reposition?.() }), { cls: 'pin-pop', align: 'right' });
  return el;
}
