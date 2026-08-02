# Snap Launcher — Stream Deck plugin

One key press launches (or focuses) an application and snaps its window into place — on any monitor in a multi-monitor layout, including monitors left of or above the primary (negative coordinates).

Runs on **Windows 10+ and macOS 13+**.

- On Windows it works with classic desktop apps (`.exe`/`.lnk`) **and Microsoft Store apps** (WhatsApp, Spotify, Settings, …), driving Windows PowerShell 5.1 and the Win32 window APIs (`SetWindowPos`, `GetWindowRect`, `EnumDisplayMonitors`).
- On macOS it works with any `.app` bundle, driving `osascript` (JXA), System Events, and AppKit. **It needs Accessibility permission** — see [macOS setup](#macos-setup).
- On both, it works with **Steam games** — picked from your Steam libraries and launched through Steam itself. See [Steam games](#steam-games).

Two platform differences worth knowing up front:

| | Windows | macOS |
| --- | --- | --- |
| Extra permission needed | none | **Accessibility** (one-time) |
| Virtual desktops / Spaces | supported | not supported — the section is hidden |

Two actions:

- **Launch & Position** — launch (or focus) an app, optionally on a virtual desktop, and snap its window into place.
- **Close App** — close an app's windows gracefully (like clicking ✕), with optional force-quit.

## macOS setup

Moving another application's windows is a privileged operation on macOS, so **Stream Deck must be trusted for Accessibility** before Snap Launcher can position, capture, or close anything:

1. Open **System Settings → Privacy & Security → Accessibility**.
2. Enable **Stream Deck** in the list. (If it isn't listed, press a Snap Launcher key once — the plugin will tell you what's missing — then add Stream Deck with the **+** button.)
3. Press the key again. No restart is needed.

Until that's granted, keys show an error naming the permission and where to grant it. Browsing for apps and listing monitors keep working without it — only window control is blocked.

Two notes on how the macOS side behaves:

- **You are never asked to approve individual apps.** Snap Launcher launches apps with `open` and drives their windows through System Events, so macOS asks once for Accessibility rather than "Stream Deck wants to control Slack" for every app you put on a key.
- **Spaces (virtual desktops) are not supported.** macOS has no public API to enumerate, create, name, or move another app's windows between Spaces, so the **Virtual desktop** section is hidden on macOS. A key configured with one on Windows still works on a Mac — the setting is kept and ignored.

## Quick start

1. Drag **Snap Launcher → Launch & Position** onto a key.
2. In the **Application** section, pick the app (see [Choosing the application](#choosing-the-application) below).
3. In the **Window position** section, pick a positioning mode — or leave it and click **Capture** with the app's window arranged how you like it.
4. Press the key. If the app is already running its window is focused and moved into place; otherwise it's launched, the plugin waits for its window, then positions it.

The settings panel is organised into four sections:

| Section | What's in it |
| --- | --- |
| **Application** | Which app to launch, and any command-line arguments. |
| **Launch** | Whether to reuse an already-running window, and how long to wait for a window after launching. |
| **Virtual desktop** | Optionally run the app on a named Windows 11 virtual desktop — created on the fly, switched to on press. |
| **Window position** | Where the window goes: a snap zone on a chosen monitor, an exact captured rectangle, or nowhere. |
| **Advanced — window matching** | Only needed when the plugin grabs the wrong window. Most keys leave these empty. |

## Choosing the application

The **Choose from** selector switches between four ways of picking an app. All four set the same thing (the **Selected app** line always shows what's currently chosen — whichever picker you used last wins):

- **Running apps** — every app that currently has a visible window. Start the app, click the refresh icon, pick it from the list. Works for everything, including Store apps on Windows.
- **Installed apps** — everything installed on the machine, no need to start the app first. On Windows that's Start Menu programs plus Microsoft Store apps; on macOS it's `/Applications`, `/System/Applications`, and `~/Applications` (including one level of subfolders like Utilities). Click the refresh icon after installing something new.
- **Steam games** — every game installed in your Steam libraries. See [Steam games](#steam-games).
- **Browse for a file** — point straight at an `.exe`, `.lnk`, `.bat`, or `.cmd` on Windows, or an `.app` bundle on macOS.

Picking an app also sets the key's title to the app's name (e.g. "WhatsApp"). Anything you type in Stream Deck's own **Title** field always takes precedence.

On macOS an app is remembered by its **bundle identifier** wherever possible, so a key keeps working after the app is updated, renamed, or moved between `/Applications` and `~/Applications`.

## Steam games

Choose **Steam games** in the **Choose from** selector and the dropdown lists every game installed in your Steam libraries — every library folder, not just the one Steam itself lives in. Pick one and the key is done; there's nothing to browse for and no executable to find.

Pressing the key **launches the game through Steam**, exactly like clicking Play:

- Steam starts first if it isn't already running.
- The game's own **launch options**, cloud saves, controller config, and overlay all apply — none of which happens if you point a key at the game's `.exe` directly, and which some games refuse to start without.
- Anything you type in **Arguments** is passed to the game on top of its Steam launch options.

Positioning, virtual desktops, and the **Close App** action all work on a game like they do on any other app:

- **Windows are matched by the game's install folder**, because a game's executable name is the developer's choice and can change with an update. Everything Steam installed for the game — the game itself, a launcher, an anti-cheat front-end — lives under that folder, so that's the boundary used. The **Process name** override still works if you need to pin down one executable exactly.
- **A game you aren't positioning is never waited for.** Games can spend minutes in Steam's bootstrap, shader compilation, and anti-cheat checks. With **Positioning** set to *Don't move the window*, the key hands the game to Steam and reports success immediately rather than failing on a timeout. Set a zone or a captured rectangle and the key does wait — raise **Wait (seconds)** well above the default 10 for a game.
- **Fullscreen games can't be repositioned.** That's the game's own display mode, not a plugin limitation — switch the game to windowed or borderless if you want a key to snap it.

A key stores the game's **Steam app id**, so it keeps working when the game is updated, verified, or moved to another library folder or drive. If the game is uninstalled, the key says so by name instead of failing obscurely.

Games installed by other launchers, and *non-Steam shortcuts* you've added to your Steam library, aren't listed — point a key at those with **Installed apps** or **Browse for a file**.

## Virtual desktops (Windows 11 only)

Type a name into **Desktop name** (e.g. `Work`, `Music`) and the key becomes desktop-aware. On every press the plugin:

1. Finds the virtual desktop with that name (case-insensitive) — or **creates and names it** if it doesn't exist. `Desktop 2` targets the second desktop by position, creating desktops up to that number if needed.
2. **Switches** to that desktop.
3. Launches the app there — or, if it's already running on another desktop, **moves its window over**.
4. Applies the normal window positioning (zone or captured rectangle).

So one key press can mean: "take me to my *Comms* desktop with WhatsApp snapped to the right half" — whether or not that desktop or app was open beforehand. Leave the field empty (the default) and everything happens on the current desktop, as before.

Windows 11 only — Windows 10 exposes no API for this, and a key with a desktop name set will show a clear error there.

## Positioning the window

Three modes, chosen with the **Positioning** dropdown:

- **Monitor & snap zone** — pick a **Monitor** ("Primary monitor" follows whichever display is primary; the numbered entries pin a specific display) and a **Zone** (full screen, halves, quarters — exactly like the Windows Snap layouts). The position is worked out fresh on every key press, so it keeps working when you change resolution, scaling, or monitor arrangement. No capturing needed.
- **Custom position (capture / manual)** — arrange the app's window exactly where you want it, then click **Capture current window position & size**. The X/Y/Width/Height fields fill in and the Status line confirms what was saved. The key restores that exact geometry from then on. (You can also type coordinates by hand.)
- **Don't move the window** — the key becomes a plain launcher/focuser.

## Closing apps

Drag **Snap Launcher → Close App** onto a key, pick the app exactly like for a launch key, and choose how to close:

- **Close gracefully (like clicking ✕)** — the default. Posts a close request to every matching window, so apps can prompt to save unsaved work. This never loses data.
- **Close, force-quit if still open** — asks nicely first, then waits (**Wait (seconds)**, default 5) and force-quits whatever is still running. Good for apps that hide to the tray or hang on exit.
- **Force-quit immediately** — ends the process without asking. Unsaved work is lost.

Pressing the key when the app isn't running counts as success — the key is safe to mash. The **Title contains** filter works here too, so you can close just one window of a multi-window app.

### The snap zones

```
┌─────────┐  ┌────┬────┐  ┌─────────┐  ┌────┬────┐
│  Full   │  │ L  │ R  │  │  Top    │  │ TL │ TR │
│ screen  │  │half│half│  ├─────────┤  ├────┼────┤
│         │  │    │    │  │ Bottom  │  │ BL │ BR │
└─────────┘  └────┴────┘  └─────────┘  └────┴────┘
```

Zones fill the monitor's **work area** — they stop at the taskbar, just like Windows Snap. "Full screen" fills the work area but leaves the window a normal, draggable window (it isn't maximized). A left-half key and a right-half key meet with no gap or overlap, even on odd-width monitors.

If the chosen monitor isn't connected when you press the key (say, a laptop away from its dock), the window goes to the primary monitor instead — the key never fails just because a display is missing.

### All settings

| Setting | Section | What it does |
| --- | --- | --- |
| Choose from | Application | Which picker is shown: **Running apps**, **Installed apps**, **Steam games**, or **Browse for a file**. All four set the same app. |
| Running / Installed apps / Steam games / App path | Application | The app to launch. The **Selected app** line below always shows the current choice. |
| Arguments | Application | Optional command-line arguments passed on launch. For a Steam game they're passed on top of its Steam launch options. |
| If already running | Launch | Ticked (default): reuse and reposition the existing window. Unticked: always launch a new instance. |
| Wait (seconds) | Launch | How long to wait for the window after launching (default 10) — raise it for slow-starting apps. Unused for a Steam game that isn't being positioned, which is never waited for. |
| Desktop name | Virtual desktop | Windows 11 virtual desktop to run the app on (created if missing, switched to on press). Empty = current desktop. Windows only — the section is hidden on macOS. |
| Positioning | Window position | **Monitor & snap zone**, **Custom position**, or **Don't move the window**. The rows below it change to match the mode. |
| Monitor / Zone | Window position | Zone mode only: which display and which zone. Refresh the Monitor list after plugging in a new display. |
| X/Y/Width/Height + Capture | Window position | Custom mode only: the exact window rectangle. Filled by Capture, editable by hand. |
| Title contains | Advanced | Only match windows whose title contains this text — disambiguates multi-window apps. |
| Process name | Advanced | Override for window matching when the launcher differs from the windowed process (e.g. `WindowsTerminal`). Rarely needed. |

**Close App** keys share the Application and Advanced settings above, plus:

| Setting | What it does |
| --- | --- |
| How to close | **Close gracefully** (default), **Close, force-quit if still open**, or **Force-quit immediately**. |
| Wait (seconds) | Grace period before the force-quit kicks in (default 5). Only shown for the middle mode. |

Keys configured with an older version of the plugin keep working unchanged — they show up as **Custom position** with their captured rectangle intact.

## How it works

Both platforms follow the same shape: each key press runs **one** short-lived script (PowerShell on Windows, `osascript`/JXA on macOS) that does the whole job and prints a single line of JSON. Nothing stays resident, and the actions themselves are platform-agnostic — they talk to a backend interface, not to an OS.

### Steam games (both platforms)

- **Discovery is Steam's own metadata, read directly.** `steamapps/libraryfolders.vdf` lists every library folder, and each game's `appmanifest_<appid>.acf` gives its name and install folder. That's plain file reading, so it's one implementation shared by both platforms rather than two — the only platform-specific part is where Steam itself is (the registry on Windows, `~/Library/Application Support/Steam` on macOS). Runtimes that are installed like games (Steamworks redistributables, Proton, the Linux runtimes) are filtered out, and a game whose files aren't on disk isn't offered.
- **A key stores `steam:<appid>`** — the same opaque-identity approach used for Store apps and macOS bundle ids. It's resolved against the local Steam installation on every press, so a game that moves library folders is simply found in its new one.
- **Launching goes through `steam://rungameid/<appid>`**, the same URL Steam's own desktop shortcuts use, so the client is started first when needed and the game's launch options apply.
- **Window matching is by install directory**, the same mechanism Store apps use for their package location, and for the same reason: the process that ends up owning the window isn't knowable in advance.

### On macOS

- **Windows are driven through System Events, and apps are launched with `open`.** The plugin never scripts a target app directly. That is deliberate: sending an Apple Event to a specific app triggers a per-app *"Stream Deck wants to control Slack"* prompt for every app you ever put on a key. Routing everything through System Events means macOS asks once, for Accessibility, and every app works.
- **Coordinates**: `NSScreen` reports displays bottom-left-origin, while the Accessibility API positions windows top-left-origin — the latter being the same convention the Windows side already uses. Displays are converted once at enumeration, so zone maths and captured rectangles are identical on both platforms. Work areas come from `visibleFrame`, which already excludes the menu bar and Dock, so a full-screen zone never covers either — including when the Dock auto-hides or moves.
- **No border compensation**: unlike Win32's `GetWindowRect`, the Accessibility frame *is* the visible frame, so zone rectangles are applied as-is. Apps that enforce a minimum or fixed size simply keep the size they accept — the key still reports success rather than failing the press.
- **Closing**: graceful close presses the window's own close button (`AXCloseButton`), exactly like clicking the red button, so apps can still raise their save prompts. Force-quit goes through `NSRunningApplication`, not the app's quit Apple Event.

### On Windows

- **Snap zones**: the monitor and its work area are resolved at key-press time via `EnumDisplayMonitors`, so nothing goes stale when the display layout changes. Modern Windows windows carry invisible resize borders (`GetWindowRect` extends ~7 DPI-scaled pixels past the visible frame on the left, right, and bottom); the plugin measures each window's actual borders via DWM extended frame bounds and compensates, so the *visible* window edges land flush with the zone — pixel-identical to native Windows Snap.
- **Custom positions**: every PowerShell invocation opts into per-monitor-v2 DPI awareness, so capture and restore both use physical pixels in virtual-desktop coordinates — captured rectangles round-trip exactly across mixed-DPI monitor setups. If Windows rescales the window while it crosses onto a monitor with a different scale factor, the script verifies the final rectangle and reapplies once. Captured numbers include the invisible borders, so they read a few pixels larger than the visible frame — that's expected, and restoring them reproduces the visible layout exactly.
- **Store / UWP apps**: launched by AppUserModelId through the shell (their exes under `WindowsApps` are ACL-protected). Windows are matched by app package, so launcher stubs like `WhatsApp.Root.exe` spawning `WhatsApp.exe` still resolve, and the plugin repositions the `ApplicationFrameHost` frame that actually hosts UWP windows. Bare `WindowsApps` exe paths from old configs are converted to the package identity automatically.
- **Installed apps list**: classic apps come from Start Menu shortcuts (all-users and per-user) whose target is an `.exe` — picking one saves the `.lnk` path, which the launcher resolves like any shortcut. Store apps come from the shell's `AppsFolder` and are saved as `shell:AppsFolder\<AppUserModelId>`, the same form the Running-apps list produces.
- **Virtual desktops**: there is no documented Windows API to enumerate, create, or switch virtual desktops, or to move another process's window between them — the plugin uses the shell's internal COM interfaces (interface definitions derived from the MIT-licensed [MScholtes/VirtualDesktop](https://github.com/MScholtes/VirtualDesktop)). Windows 11 24H2 changed the internal vtable without changing the interface ID, so the plugin detects the build number (26100+) and picks the matching layout; Windows 10 is rejected with a clear message. A future Windows update could change these interfaces again — if virtual-desktop keys suddenly fail after an update, check for a plugin update.

## Project layout

```
StreamDeckWindowResize\
├── src\                                  TypeScript plugin source
│   ├── plugin.ts                         entry point, registers the actions
│   ├── settings.ts                       key settings types + normalization/migration
│   ├── monitors.ts                       monitor list -> Property Inspector items
│   ├── platform\                         the OS backends behind one interface
│   │   ├── types.ts / backend.ts         shared shapes + the backend contract
│   │   ├── index.ts                      picks the backend for the running OS
│   │   ├── steam.ts                      Steam library discovery (shared by both)
│   │   ├── windows\                      PowerShell script builders + runner
│   │   └── macos\                        osascript (JXA) script builders + runner
│   └── actions\                          launch-app.ts, close-app.ts, pickers.ts (shared PI dropdowns)
├── tests\                                node:test suite (zone math, monitors, settings, Steam)
├── com.bowerstudio.snap-launcher.sdPlugin\   the plugin bundle Stream Deck loads
│   ├── manifest.json                     plugin metadata (name, version, UUID)
│   ├── ui\launch.html                    Property Inspector (key settings UI)
│   ├── imgs\                             icons
│   └── bin\plugin.js                     build output (generated — don't edit)
├── package.json / rollup.config.mjs / tsconfig.json
└── com.bowerstudio.snap-launcher.streamDeckPlugin   packed release (generated)
```

## Development

Prerequisites: Windows 10/11, Stream Deck software 7.1+, and Node.js 24+. (The Elgato CLI is also needed, but `dev.ps1` installs it for you when missing.)

### The easy way: dev.ps1

[`dev.ps1`](dev.ps1) wraps the whole workflow — it runs `npm install`, installs the Elgato CLI if it's missing, builds, and then does whatever the task asks:

```powershell
.\dev.ps1            # install dependencies + build (the default)
.\dev.ps1 link       # first-time setup: build + link the plugin into Stream Deck
.\dev.ps1 watch      # dev loop: rebuild on save + restart the plugin (Ctrl+C to stop)
.\dev.ps1 pack       # build + create the .streamDeckPlugin installer
.\dev.ps1 restart    # just restart the plugin in Stream Deck
```

Add `-SkipInstall` to any task to skip the `npm install` step. If your machine blocks unsigned scripts, run it as `powershell -ExecutionPolicy Bypass -File .\dev.ps1 <task>`.

### The manual way

First-time setup — install dependencies, build, and link the plugin folder into Stream Deck (creates a junction, so Stream Deck always runs what you build):

```bash
npm install
npm run build
streamdeck link com.bowerstudio.snap-launcher.sdPlugin
```

After that, deploying a change is just:

```bash
npm run build
streamdeck restart com.bowerstudio.snap-launcher
```

Or use `npm run watch`, which rebuilds on save and restarts the plugin automatically.

Run the tests with:

```bash
npm test
```

The suite runs the plugin's actual embedded PowerShell (zone math against real work-area rectangles, live monitor enumeration, settings migration), so it takes ~20 seconds and must run on Windows. The `tests/**/*.test.ts` glob in the test script is deliberate — `node --test tests/` (bare directory) does not work here.

Logs live in `com.bowerstudio.snap-launcher.sdPlugin/logs/`.

## Packaging a release

```powershell
.\dev.ps1 pack
```

(or manually: `npm run build` then `streamdeck pack com.bowerstudio.snap-launcher.sdPlugin`)

This produces `com.bowerstudio.snap-launcher.streamDeckPlugin` in the project root — that file is the installer to share; double-clicking it on another machine installs the plugin.

⚠️ Don't double-click the packed file on **this** machine while the dev version is linked — it's the same UUID and Stream Deck will refuse (or fight the link). Unlink first if you want to test the packed install here.

Before publishing:

1. Bump the version in `com.bowerstudio.snap-launcher.sdPlugin/manifest.json` (`Version`, four segments, e.g. `1.2.0.0`) and keep `package.json`'s `version` in step.
2. Replace the placeholder UUID `com.bowerstudio.snap-launcher` with your own reverse-DNS identifier **everywhere** — it is permanent once published:
   - `manifest.json` → `UUID` and the action's `UUID`
   - `src/actions/launch-app.ts` → the `@action({ UUID: … })` decorator
   - the `.sdPlugin` folder name, `rollup.config.mjs` → `sdPlugin` constant, and the `streamdeck restart` name in `package.json`
3. Set `Nodejs.Debug` to `"disabled"` in `manifest.json` and lower the log level in `src/plugin.ts` (it's `debug` for development).
4. Test on a real device — at minimum the key press (launch, focus, reposition) for a zone key and a custom key, plus the Capture button, for a classic app, a Store app, and a Steam game (both with and without positioning).

## Troubleshooting

### Steam games

- **The Steam games list is empty**: Steam isn't installed where the plugin looks, or no games are fully installed. Click the refresh icon after installing a game. On Windows the plugin reads Steam's own registry entry, then falls back to `Program Files (x86)\Steam`; on macOS it looks in `~/Library/Application Support/Steam`.
- **A game is missing from the list**: games still downloading, and games installed by other launchers or added as *non-Steam shortcuts*, aren't listed. Use **Installed apps** or **Browse for a file** for those.
- **"…does not appear to be installed in any Steam library"**: the game was uninstalled or moved to a drive that isn't mounted. Reinstall it, or re-pick the game in the key settings.
- **The game launches but the window isn't positioned**: fullscreen games can't be moved — switch the game to windowed or borderless mode. If it is windowed, raise **Wait (seconds)** (games are slow to show a window) and check the game isn't applying its own saved geometry afterwards.
- **The wrong window is grabbed**: some games show a launcher window first. Add a **Title contains** filter matching the real game window, or set **Process name** to the game's executable.

### macOS

- **"Stream Deck needs Accessibility access"**: enable **Stream Deck** under System Settings → Privacy & Security → Accessibility, then press the key again — no restart needed. See [macOS setup](#macos-setup). Note the permission belongs to the Stream Deck application, not to Snap Launcher, so it survives plugin updates but is lost if you reinstall Stream Deck itself.
- **No Virtual desktop section**: expected. macOS Spaces have no public API for the things this feature needs, so it's Windows-only.
- **App can't be found after moving it**: keys remember apps by bundle identifier, so this should be rare — if it happens, re-pick the app in the key settings.
- **Window doesn't fill the zone exactly**: some macOS apps enforce a minimum or fixed window size and refuse to be resized. The key still succeeds and leaves the window at the size the app accepted.

### Windows

- **Nothing moves / access denied**: elevated (run-as-administrator) windows can't be repositioned by a non-elevated process (UIPI), and they don't appear in the Running apps list. Launch such apps unelevated, or run the Stream Deck software elevated (not generally recommended).
- **App missing from the Installed apps list**: the list is built from Start Menu shortcuts and Microsoft Store packages, so portable apps that never created a shortcut won't appear — use **Browse for a file** (or **Running apps** while the app is open) instead. Click the refresh icon after installing something new.
- **Monitor missing from the dropdown**: click the refresh icon next to the Monitor list — it's populated when the settings panel opens, so displays plugged in afterwards need a refresh.
- **Window snaps to the wrong display**: "Primary monitor" follows Windows' current primary. If you want a key pinned to a physical display, pick its numbered entry instead.
- **Store app window isn't found**: set **Process name** to the app's windowed process. The old `explorer.exe` + `shell:AppsFolder\…`-in-Arguments workaround from earlier versions also still works.
- **Window ends up a slightly different size**: some apps (Chromium-based ones especially) clamp or restore their own geometry after startup. Re-capture after the app settles, or increase **Wait (seconds)**. A few apps with fixed-size or custom-drawn windows can't fill a zone exactly.
- **Timed out waiting for a window**: slow-starting apps need a larger **Wait (seconds)**; splash-screen apps sometimes need a **Title contains** filter so the real window is matched.
- **Capture errors**: the app must be running with a visible (not minimized) window when you click Capture.
- **"Virtual desktop control is unavailable"**: virtual desktops need Windows 11 (build 22000+). If you're on Windows 11 and it still fails, a Windows update may have changed the internal desktop interfaces — clear the **Desktop name** field to keep using the key on the current desktop, and check for a plugin update.
- **Wrong desktop targeted by "Desktop N"**: a name like `Desktop 2` first matches a desktop actually *named* "Desktop 2", then falls back to the second desktop by position. Renamed desktops are matched by their name only.
- **Offline machines**: the Property Inspector loads `sdpi-components` from its CDN. If offline, download `sdpi-components.js` into `ui/` and change the `<script src>` in `ui/launch.html` to the local file.
