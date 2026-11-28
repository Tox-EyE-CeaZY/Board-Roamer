<div align="center">

<img src="https://raw.githubusercontent.com/Tox-EyE-CeaZY/Board-Roamer/main/.github/assets/banner.svg" alt="Board Roamer" width="100%">

<br>

[![Latest release](https://img.shields.io/github/v/release/Tox-EyE-CeaZY/Board-Roamer?style=for-the-badge&color=b1ef4a&labelColor=040e10&label=latest)](../../releases/latest)
![Windows](https://img.shields.io/badge/Windows-040e10?style=for-the-badge&logo=windows&logoColor=b1ef4a)
![macOS](https://img.shields.io/badge/macOS-040e10?style=for-the-badge&logo=apple&logoColor=b1ef4a)
![Linux](https://img.shields.io/badge/Linux-040e10?style=for-the-badge&logo=linux&logoColor=b1ef4a)
![Android](https://img.shields.io/badge/Android-040e10?style=for-the-badge&logo=android&logoColor=b1ef4a)

**A fast, good-looking way to browse e621 and other boards, follow your favorite artists, read comics, and keep it all in sync between your computer and your phone.**

[Download](#-download) · [What it does](#-what-it-does) · [Fur Affinity](#-fur-affinity) · [Sync](#-sync-your-phone-and-computer) · [Android notes](#-android-warnings-and-permissions) · [Settings](#-settings-at-a-glance)

</div>

---

## 📦 Download

Grab the newest build from the **[Releases page](../../releases/latest)**.

| Your device | Get this file | First-time notes |
| :-- | :-- | :-- |
| **Windows** 64-bit / 32-bit / ARM | `board-roamer-windows-x64.exe` / `-x86.exe` / `-arm64.exe` | Just run it. |
| **macOS** Apple Silicon / Intel | `BoardRoamer-macos-arm64.zip` / `-x64.zip` | Unzip, then right-click the app and choose **Open** the first time. |
| **Linux** 64-bit / ARM | `board-roamer-linux-x64` / `-arm64` | Make it executable (`chmod +x`). Needs `libwebkit2gtk-4.1` installed. |
| **Android** 10 or newer | `BoardRoamer.apk` | Allow "install unknown apps" for your browser. See the [Android notes](#-android-warnings-and-permissions). |

There is nothing to set up. It's one small app, and the Android file works on every phone and tablet. `SHA256SUMS.txt` on the release page lists a checksum for every file if you'd like to verify a download.

> [!NOTE]
> **Windows on ARM:** the ARM build is not published reliably right now. If it is missing from a release, the 64-bit build runs on ARM Windows through Windows' built-in emulation.

### Staying up to date

- **Computer:** Settings → Updates checks for new versions when the app opens. When you say yes, it downloads the right build, checks it, swaps it in and restarts.
- **Android:** the same screen downloads the new APK and opens Android's installer. You confirm the install.
- Nothing is ever installed without your say-so. Turn the automatic check off any time.

### Closing the window on a computer

Closing the window keeps Board Roamer running quietly in the system tray (the menu bar on macOS), so your phone can still sync with it. Settings → Background lets you turn that off, start the app when you sign in, and choose whether it starts hidden, minimized or open. Quit from the tray icon.

---

## 🧭 What it does

<table>
<tr>
<td width="50%" valign="top">

### 🎞️ Feed
Your home screen, if you like. One post at a time, swipe for the next, double-tap to like.

- **For you** learns your taste on your own device from your favorites, upvotes and hearts, with a little wandering mixed in so it stays fresh. Nothing is uploaded.
- **Following**, **New** and **Hot** are one tap away.
- Comics show up as comics: pick up where you left off.
- Swipe a post left for that artist's page. Rate tags (never → love), mark posts *not interested*, press and hold for more.
- Gentle on the sites: slow, spaced-out requests.

</td>
<td width="50%" valign="top">

### 🔍 Search & Roam
- Tag chips with live suggestions, colours and post counts. Click a chip to cycle **require / exclude / any-of**.
- Blend several artists or tags into one feed (**ALL ⇄ ANY**).
- Filter by score, rating, type, shape and age. Quick routes like *Hot today*, *Shuffle* and **For you** as a grid.
- Star your favorite artists and tags.
- Artist and tag cards with post counts, aliases, links and wiki text.
- Paste any post, search or pool link into the search box and it opens.

</td>
</tr>
<tr>
<td valign="top">

### 🖼️ Gallery & viewer
- Smooth masonry, rows or grid, even with thousands of posts.
- Zoom, pan, pinch, rotate, slideshow, fullscreen, filmstrip.
- Tags grouped by category, with quick **+ − ★** buttons.
- A proper video player with frame-step, speed and quality.
- Favorite and upvote on e621, Danbooru and Derpibooru when signed in.

</td>
<td valign="top">

### 📌 Boards & Trail
- **Boards** hold pinned posts. **Live boards** are saved searches that keep themselves fresh and show how many posts are new.
- A live board can search **several sites at once** and show each picture only once.
- Organize everything into **folders**.
- **Trail** remembers every search. Re-run it, or save it as a board.

</td>
</tr>
<tr>
<td valign="top">

### 🔔 Follows
- Follow artists. New posts are checked quietly in the background and marked **NEW**.
- Open one artist and **walk through what's new** with Previous / Next.
- Optional notifications, generic by default, text only, never a picture.

</td>
<td valign="top">

### 📚 Pools & comics
- Pools are sorted into **Comics**, Series and Collections automatically.
- A real **comic reader**: single page, two-page spreads or continuous scroll, left-to-right or right-to-left, remembers your page.
- **Library** for the comics you're reading, with new-page alerts.
- Save a whole pool in one go, numbered, in its own folder.

</td>
</tr>
<tr>
<td valign="top">

### 💾 Downloads that remember
Saved files carry the artist, tags, source links, post link and the site's original MD5 inside the image or video, so you can always trace a file back. Formats that can't hold this get a small `.xmp` file beside them. Windows Explorer shows the title, authors and tags for JPG and PNG. Switch it off in Settings → Data.

</td>
<td valign="top">

### 🗂️ Local files
Turn on **Local** (Settings → Local) to browse the pictures and videos in folders you pick, on this device and on your other synced devices. It never changes your files; tags you add stay inside Board Roamer, and the tags Board Roamer embedded in its own downloads are read back.

</td>
</tr>
</table>

### Supported sites

**e621** is where Board Roamer feels most at home. **e926, Danbooru, Gelbooru, Safebooru and Derpibooru** work too, and **Fur Affinity** has its own [section](#-fur-affinity).

<details>
<summary><b>Good to know about the sites</b></summary>

- e621 asks apps to identify themselves. Put something like `BoardRoamer (by yourname on e621)` under Settings → Sources → User-Agent. Rate limiting is handled for you.
- Gelbooru needs a free API key and user ID. Danbooru limits signed-out searches to 2 tags.
- Derpibooru works without an account. A key is optional and brings your own filter.
- Favoriting and upvoting need you to sign in with an API key (Settings → Sources).

</details>

### Everything else

- **Blacklist** with a click-to-reveal veil, or add `#blur` to a rule to blur instead of hide. The **Cloak** key (`` ` ``) instantly swaps the screen for a plain document. A comic is only hidden when most of its pages match, never because of one page.
- **Tabs** (optional): open anything in a new tab, and each tab keeps its own search, results and place. Ctrl+T, Ctrl+W, Ctrl+Tab and Ctrl+Shift+T work like a browser.
- **Right-click or long-press** nearly anything for a menu that fits.
- **Three themes:** night, paper and violet, with an accent colour slider and an optional topographic backdrop.
- **Press `?`** in the app for every shortcut and gesture.
- **Backup:** Settings → Data → Export backup saves your boards, follows, trail and settings as one file.

---

## 🐾 Fur Affinity

Fur Affinity has its own section with the gallery, viewer, follows and filters you already know. Turn it on in **Settings → Sources → Fur Affinity** (computer and Android).

- Browse the **Latest** and **Browse** pages, open any artist (Home, Gallery, Scraps, Favorites, Folders), and read stories and listen to music submissions.
- **Sign in** in a small window when you want to see mature and adult content. Your sign-in stays on that device only and is never synced or shared.
- **Follow** artists, and import your watch list in one tap. Watch and unwatch from inside the app.
- **Fur Affinity Feed:** the paw button in the Feed switches to a feed made only of Fur Affinity posts, with its own For you taste learning.
- **Seen** and **Liked** tabs search what you've already looked at on this device.

<details>
<summary><b>What to expect from Fur Affinity</b></summary>

- Fur Affinity has no public API, so Board Roamer reads its pages **slowly, one request a second**, and respects the site's rules about what automated apps may open. Search, messages and the site's own favorite/watch pages open in your browser instead.
- Favorites and upvotes there are **kept in Board Roamer only**, not on Fur Affinity.
- Checking followed artists in the background is **off by default**. "Check for new" always works.
- If Fur Affinity shows a Cloudflare check, Board Roamer shows a tappable prompt. Nothing is forced open.
- This part is new, so expect some rough edges while it gets tested on more devices.

</details>

---

## 🔄 Sync your phone and computer

1. On the computer, open **Settings → Sync** and choose **Add a phone**. A QR code appears.
2. On the phone, open **Settings → Sync → Scan the code**. (A typed code works too.)
3. That's it. Your computer is found on your home Wi-Fi by itself.

Boards, pins, follows, library, trail, reading progress, what the Feed has learned, and your look and search settings sync both ways. Logins and layout sizes stay on each device.

- The computer is the hub, so keep Board Roamer running there (the tray does this). Phones sync through the computer.
- The connection is encrypted and tied to that one computer, so a roommate's Board Roamer on the same Wi-Fi is ignored.
- **Away from home?** Install [Tailscale](https://tailscale.com) on both devices and it works the same way. The app suggests it if it can't reach your computer.
- Phones paired on a version older than 2.13 need to pair again once.
- On Windows, the first time you turn on sharing, allow Board Roamer through the firewall.

---

## 📱 On your phone

- Bottom tab bar, sheets instead of pop-ups, swipe, pinch and long-press gestures, pull to refresh and a touch-friendly comic reader.
- **Home screen widgets (Android):** nine widgets in three families: *Following* (new-post counts), *Library* (covers and new pages) and *Local* (your folders). Pick a square or fully rounded look. Adult pictures stay hidden unless you allow them.
- **Links:** links to posts, searches and pools on the supported sites can open in Board Roamer (Settings → This device → Links).
- **Share:** use Android's Share menu to send a link to Board Roamer.
- **Privacy:** optional privacy screen, cloak-on-switch and blurred thumbnails for use in public.
- **Foldables and the Surface Duo** get a layout that keeps everything clear of the hinge.

---

## 🛡️ Android warnings and permissions

> [!IMPORTANT]
> **Android and Google Play Protect may say Board Roamer is "harmful", "unsafe" or "isn't commonly installed", or offer to scan it. This is expected, and it is not a sign of malware.**

**Why it happens.** Board Roamer is installed from GitHub, not from Google Play, and Android is wary of any app that arrives that way. On top of that, the app asks for two permissions that Android treats as sensitive. Both power real features:

| Permission | What it's used for | Feature behind the flag |
| :-- | :-- | :-- |
| **Install unknown apps** | Downloads the new APK from this project's releases, checks it against `SHA256SUMS.txt`, and hands it to Android's installer. | **Settings → Updates** (the in-app updater) |
| **All files access** | Lets you browse folders *you* pick, and share them with your other devices if you choose. Off until you turn Local on. The app never reads other folders. | **Settings → Local** |

The updater permission is the one that most commonly trips these scans, because apps that can install other apps are a classic malware trick. Board Roamer only uses it for its own updates.

It also uses the internet, notifications, the camera (only to scan the pairing QR code, nothing is recorded), starting at boot and a quiet "Sharing with your devices" notification, so follow checks and sharing keep working with the app closed.

**If you see the warning:** choose **More details → Install anyway** (or **Scan app → Install anyway**). You can compare the download with `SHA256SUMS.txt` first. The app is signed with this project's own key, and the code is open for anyone to read.

---

## 🍎 What about iPhone and iPad?

We're looking at an iOS version, but it is **unlikely**. Apple only allows apps through its App Store, and an app like this one, which browses user-submitted adult art sites and installs outside the store, is very unlikely to be accepted. Until that changes, Windows, macOS, Linux and Android are the supported platforms. On an iPhone you can still use a booru site in the browser.

---

## ⚙️ Settings at a glance

| Menu | What's inside |
| :-- | :-- |
| **Sources** | Booru site and logins, Fur Affinity, local folders |
| **Look & layout** | Theme, accent colour, home screen, tabs, gallery layout |
| **Viewer** | Video, zoom, scrolling, how a post opens (classic viewer or Feed style) |
| **Blacklist & starred** | Hidden tags and rules, starred artists and tags |
| **Notifications** | New posts from follows, live boards and pools |
| **This device** | Touch, privacy, links, running in the background |
| **Sync** | Pair your phone and computer |
| **Updates** | Version and update checks |
| **Data & backup** | Export and import, saved files, reset |

---

## 🛠️ For developers

<details>
<summary><b>Run from source, layout and releasing</b></summary>

### Run from source

```
cargo run --release            # native window
cargo run --release -- --browser            # serve + open in your default browser
cargo run --release -- --browser --no-open  # serve only (http://127.0.0.1:4621)
```

Or build once (`cargo build --release`) and double-click `target\release\board-roamer.exe`.
Launching it a second time reuses the running instance, so your boards are shared.

Your data (boards, trail, settings) lives in the WebView profile: `%LOCALAPPDATA%\BoardRoamer` on Windows,
`~/Library/Application Support/BoardRoamer` on macOS, `~/.local/share/BoardRoamer` on Linux. Downloads go to `Downloads/Board Roamer`.

On Linux, install the web view first: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev libayatana-appindicator3-dev` (the last one is for the tray icon).

### Notes

- e621 asks API clients to identify themselves: set a User-Agent like `BoardRoamer/0.1 (by yourname on e621)` in
  Settings → Source. Rate limiting (≈2 req/s) is handled for you.
- Gelbooru requires a free API key/user ID; Danbooru limits signed-out searches to 2 tags.
- Adding a site: write an adapter in `ui/js/providers.js` (normalise to the shared post shape) and allow its host in `src/proxy.rs`.

### Layout

```
src/main.rs     window, static server, routing
src/proxy.rs    allow-listed API proxy, throttle + cache, saving, image fallback
ui/             embedded frontend (vanilla ES modules, no build step)
  js/providers.js   site adapters, feeds, blacklist
  js/gallery.js     virtualized layout engine
  js/viewer.js      lightbox
  js/search.js      chip search bar
  vendor/           the style model and its runtime (licenses in vendor/NOTICE.md)
```

### Building and releasing

Every push to `main` builds all platforms in GitHub Actions (`.github/workflows/build.yml`). Pushing a tag publishes a release:

```
git tag v1.4.0
git push origin v1.4.0
```

The tag becomes the app version, the builds are attached to the release together with `SHA256SUMS.txt`, and installed
copies offer the update.

**Android signing.** An Android update only installs over an older version if both are signed with the same key. The key is
never committed. Create it once with `python android/build.py` (it writes `android/board-roamer.keystore` and
`android/keystore.pass`), back both up somewhere private, then add two repository secrets (Settings → Secrets and variables → Actions):

- `ANDROID_KEYSTORE_B64`: the keystore file, base64-encoded (`base64 -w0 android/board-roamer.keystore`)
- `ANDROID_KEYSTORE_PASS`: the contents of `android/keystore.pass`

Local Android build: `python android/build.py` (needs the Android SDK build-tools 34, platform 34 and a JDK).

</details>

---

<div align="center"><sub>Made for roaming. Not affiliated with any of the sites it can browse.</sub></div>
