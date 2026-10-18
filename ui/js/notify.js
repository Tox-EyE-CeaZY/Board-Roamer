/**
 * System notifications for new content. Privacy comes first: a notification is only ever words, never a picture, and
 * the words stay generic ("New posts from your follows"). The one opt-in is naming the followed artists
 * (Settings > Notifications). They are shown only while the app is not in front of you, since the badges already say it.
 */
import { S } from './store.js';
import { pretty } from './util.js';
import { isAndroid, native } from './platform.js';

const TITLE = 'Board Roamer';
const FLAG = { follows: 'notifyFollows', boards: 'notifyBoards', pools: 'notifyPools' };
const pending = new Map(); // kind -> artist names (follows only)
let timer = null;

const list = (names) => {
  const n = names.map(pretty);
  return n.length <= 2 ? n.join(' and ') : `${n.slice(0, 2).join(', ')} and ${n.length - 2} more`;
};

function words() {
  const kinds = [...pending.keys()];
  if (kinds.length === 1) {
    const [kind] = kinds;
    if (kind === 'follows') return S('notifyNames') && pending.get(kind).length ? `New posts from ${list(pending.get(kind))}` : 'New posts from your follows';
    return kind === 'boards' ? 'Your boards have new updates' : 'New pages in your pools';
  }
  const parts = kinds.map((k) => (k === 'follows' ? 'follows' : k));
  return `New activity in your ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

export function send(body) {
  if (isAndroid()) return native.notify(TITLE, body);
  fetch('/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: TITLE, body }) }).catch(() => {});
}

export const canNotify = () => !isAndroid() || native.notifyAllowed();

/** Something new turned up. Several kinds arriving close together become one notification. */
export function announce(kind, names = []) {
  if (isAndroid()) return; // the phone's background job (Watch.java) does the looking, even with the app closed
  if (!S('notify') || !S(FLAG[kind]) || !canNotify()) return;
  if (!document.hidden && document.hasFocus()) return;
  pending.set(kind, [...(pending.get(kind) || []), ...names]);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const body = words();
    pending.clear();
    send(body);
  }, 2500);
}

export function sendTest() {
  send(S('notifyNames') ? 'New posts from an artist you follow' : 'New posts from your follows');
}
