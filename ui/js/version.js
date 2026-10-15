/** The GitHub project that publishes releases. Keep in sync with REPO in src/updater.rs and Updater.java. */
export const REPO = 'Tox-EyE-CeaZY/Board-Roamer';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;

/** "v1.10.2" -> [1, 10, 2] */
export const parseVersion = (v) => (String(v || '').match(/\d+/g) || []).slice(0, 3).map(Number).concat([0, 0, 0]).slice(0, 3);

/** True when `a` is a newer version than `b`. */
export function isNewer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
