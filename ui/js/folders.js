/**
 * Folders for boards (pin boards and live boards) and for library titles (pools and comics). The data lives in store.js
 * (`folders`); this file is the shared look and the "move to folder" menu so Boards and the Library behave the same.
 */
import { h } from './util.js';
import { icon } from './icons.js';
import { folders } from './store.js';
import { promptText, confirmDlg, toast } from './ui.js';

export async function newFolder(kind) {
  const n = await promptText('New folder', '', kind === 'boards' ? 'e.g. Wallpapers, Reference…' : 'e.g. Reading now, Finished…');
  return n ? folders.create(n, kind) : null;
}

/** The "Move to folder" entry for a context menu. `move(folderId|null)` does the actual change. */
export function moveEntry(kind, item, move) {
  const list = folders.all(kind);
  return {
    label: 'Move to folder', icon: 'folder',
    sub: [
      ...list.map((f) => ({ label: f.name, checked: item.folder === f.id, run: () => move(f.id) })),
      { label: 'New folder…', icon: 'plus', run: async () => { const f = await newFolder(kind); if (f) move(f.id); } },
      item.folder && folders.get(item.folder) && { label: 'Take out of folder', icon: 'up', run: () => move(null) },
    ],
  };
}

/** A folder tile. `covers` are up to three thumbnail urls from what is inside. */
export function folderCard(f, { count, noun, covers = [], onOpen, onDrop, menu }) {
  const el = h('article', { class: 'fldr', tabindex: 0, 'data-folder': f.id, title: f.name },
    h('div', { class: 'fl-top' }, h('i', { html: icon('folder', 22) }), h('h3', {}, f.name)),
    h('div', { class: 'fl-thumbs' }, covers.slice(0, 3).map((u) => h('img', { src: u, alt: '', loading: 'lazy', draggable: 'false', onerror: (e) => e.target.remove() }))),
    h('div', { class: 'fl-meta' }, `${count} ${noun}${count === 1 ? '' : 's'}`));
  el.addEventListener('click', onOpen);
  el.addEventListener('keydown', (e) => e.key === 'Enter' && onOpen());
  if (onDrop) {
    el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-br-item')) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drop'); const id = e.dataTransfer.getData('text/x-br-item'); if (id) onDrop(id); });
  }
  return el;
}

/** Make a card draggable onto folder tiles (computers). */
export function draggableItem(el, id) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-br-item', id); e.dataTransfer.effectAllowed = 'move'; });
}

/** Right-click menu for a folder tile. */
export function folderMenu(f, refresh) {
  return [
    { header: f.name },
    { label: 'Rename', icon: 'edit', run: async () => { const n = await promptText('Rename folder', f.name); if (n) { folders.rename(f.id, n); refresh(); } } },
    { sep: true },
    { label: 'Delete folder', icon: 'trash', danger: true, run: async () => { if (await confirmDlg('Delete folder?', `“${f.name}” goes away. What is inside moves back to the top level.`)) { folders.remove(f.id); toast('Folder deleted', { ms: 1400 }); refresh(); } } },
  ];
}
