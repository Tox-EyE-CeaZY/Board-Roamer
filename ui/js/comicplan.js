/**
 * What the Feed should show when a page of a comic comes up. Pure, so it runs in node.
 *
 * A single page from the middle of a story is no use, so: a comic in your library comes up where you are in it (the page you stopped on,
 * or the first new one), and not at all once you have read everything; any other comic comes up at its first page.
 */
const pages = (n) => `${n} new page${n === 1 ? '' : 's'}`;

/**
 * The reader only counts the pages it can show (hidden or deleted ones are missing from it), so "finished" is judged by its own numbers,
 * and new pages by the library's.
 *
 * @param count  pages in the comic, as the site lists them
 * @param lib    its library entry ({seenCount}), or null
 * @param read   reading progress ({i: page last on, total: pages the reader had, page: that page's place in the site's list}), or null
 * @returns      { page, label, action } with `page` = place in the site's list to show and open at, or null when there is nothing left to read
 */
export function comicPlan({ count, lib = null, read = null }) {
  const finished = !!read && read.i >= (read.total || count) - 1;
  const here = read ? Math.min(read.page ?? read.i, count - 1) : 0;
  const added = lib ? Math.min(count, Math.max(0, count - (lib.seenCount ?? count))) : 0;
  const resume = !finished && here > 0 ? { page: here, label: lib ? 'Continue reading' : 'Comic you started', action: 'Continue reading' } : null;
  if (!lib) return resume || { page: 0, label: 'Comic', action: 'Read from page 1' }; // started it from somewhere else: carry on
  const fresh = added ? { page: count - added, label: pages(added), action: 'Read new pages' } : null;
  if (finished) return fresh;
  if (resume) return resume;
  if (fresh) return fresh;
  return { page: 0, label: 'In your library', action: 'Start reading' };
}
