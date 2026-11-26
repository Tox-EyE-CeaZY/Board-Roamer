# Sync: pairing, discovery, encryption (2.13.0)

Notes on what the code does, so the next change doesn't have to rediscover it. (The library merge itself is `ui/js/syncmerge.js`.)

## Host (`src/sync.rs`, the computer)
- Identity: random 64-bit `id`, a self-signed certificate made once (`sync-cert.pem` / `sync-key.pem` in the data dir) and its SHA-256
  fingerprint. The user-given `name` defaults to the computer's name. All in `sync-config.json` (+ the two pem files).
- The network listener is **HTTPS** (tiny_http `ssl-rustls`, rcgen). The app's own window still uses plain loopback.
- **Pairing**: "Add a phone" (`POST /sync/config {pair:true}`) makes a one-time 16-character key valid 10 minutes for ONE device. The QR code
  (`/sync/qr`, SVG, loopback only) holds `boardroamer://pair?v=1&id&n&k&fp&a=ip:port,...`. The phone never sends the key: `POST /sync/pair`
  carries `HMAC(key, "pair-c|nonce|fp seen")`; the answer holds a 256-bit device token and `HMAC(key, "pair-h|nonce|fp|token")`, which proves
  the computer made the key. Both proofs cover the fingerprint, so a man in the middle fails one of them, which is also why typing the key
  (no fingerprint known) is still safe. 5 wrong proofs burn the key; 8 failures a minute lock the listener (429).
- Every other route needs `Authorization: Bearer <device token>` from the paired list (constant-time compare). Revoke: `{revoke: id}`,
  `{revokeAll: true}`. Turning sharing off clears the runtime state, not the pairings.
- **Discovery**: `_boardroamer._tcp.local.` via mdns-sd, instance `br-<id>`, host `br-<id8>.local`, TXT `id`, `name`, `fp` (first 16), `v`.
  Not relying on a multi-label `.local` name: Android resolves those badly. Several computers on one network are normal; a phone only
  uses the one whose id it saved.
- A phone's own folder server (`Local.java`) is plain http on the LAN, so the computer never gives it the device token: it is sent
  `HMAC(token, "share")` (`share_code`), and `/sync/devices` hands each phone the others' share codes.
- Test: `cargo test pairing` (needs `curl`) drives pairing and auth against the real listener. `cargo test serve_for_interop -- --ignored`
  serves a pairing for 40 s so the phone's Java (`Hub.pair`) can be run against it.

## Phone (`ui/js/sync.js`, `android/.../Hub.java`)
- `Hub.java`: TLS that trusts exactly the pinned fingerprint (`Hub.open`), `pair`, `discover` (NsdManager), `netInfo` (own addresses,
  Tailscale = 100.64/10). Bridge: `pairHub`, `discoverHubs`, `netInfo`, `setHub(url, token, fp)`.
- Stored per phone (localStorage `br1:syncCfg`): `id, host, fp, token, port, addrs[], url`. A config from before 2.13 (url, no fp) is cleared
  and `old` is set so Settings says to pair again.
- Finding the computer again (`findHub` in sync.js): when a call can't connect, ask mDNS for the saved id, then try the saved addresses
  (Tailscale ones included). `/sync/info` reports the computer's current addresses, so a Tailscale address appears on the phone after
  Tailscale is installed on the computer and the phone has synced once at home.
- `connectionAdvice()`: no Tailscale on the phone → suggest installing it on both; phone has it but the computer doesn't → install there too.
- QR scanning: `ui/js/qrscan.js`, `getUserMedia` + `BarcodeDetector` when present, else bundled jsQR (`ui/vendor/jsqr`). The shell grants the
  camera to our own page only (`MainActivity.onPermissionRequest`), manifest has `CAMERA` (optional hardware).
