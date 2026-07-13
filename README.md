# Snap Launcher — Stream Deck plugin

One key press launches (or focuses) an application and snaps its window into place — on any monitor in a multi-monitor layout, including monitors left of or above the primary (negative coordinates).

Two ways to position a window:

- **Monitor & snap zone** — pick a monitor and a zone (full screen, left/right half, top/bottom half, or a quarter), exactly like the Windows Snap layouts. The position is worked out fresh on every key press, so it keeps working when you change resolution, scaling, or monitor arrangement.
- **Custom position** — arrange the window by hand once, click **Capture**, and the key restores that exact geometry from then on. No coordinates to type.

Works with classic desktop apps (`.exe`/`.lnk`) **and Microsoft Store apps** (WhatsApp, Spotify, Settings, …).

Windows only: the plugin drives Windows PowerShell 5.1 and the Win32 window APIs (`SetWindowPos`, `GetWindowRect`, `EnumDisplayMonitors`).

## Setting up a key

1. Drag **Snap Launcher → Launch & Position** onto a key.
2. Choose the app:
   - **Running apps** dropdown — start the app, click the refresh icon, and pick it. This works for everything, including Store apps (they're saved as a `shell:AppsFolder\<AppUserModelId>` entry the plugin knows how to launch).
   - **App path** — browse to an `.exe`, `.lnk`, `.bat`, or `.cmd` directly.

   Picking an app also sets the key's title to the app's name (e.g. "WhatsApp"). Anything you type in the **Title** field yourself always takes precedence.
3. Choose a **Positioning** mode:
   - **Monitor & snap zone** — pick a **Monitor** ("Primary monitor" follows whichever display is primary; the numbered entries pin a specific display) and a **Zone**. Done — no capturing needed.
   - **Custom position (capture / manual)** — arrange the app's window exactly where you want it, then click **Capture current window position & size**. The X/Y/Width/Height fields fill in and the Status line confirms what was saved.
   - **Don't move the window** — the key becomes a plain launcher/focuser.
4. Press the key: if the app is running, its window is focused and moved into place; otherwise it's launched, the plugin waits for its window, then positions it.

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

| Setting | What it does |
| --- | --- |
| Running apps / App path | The app to launch — both write the same setting; whichever you set last wins. |
| Arguments | Optional command-line arguments passed on launch. |
| Title contains | Only match windows whose title contains this text — disambiguates multi-window apps. |
| Process name | Override for window matching when the launcher differs from the windowed process (e.g. `WindowsTerminal`). Rarely needed. |
| If already running | Ticked (default): reuse and reposition the existing window. Unticked: always launch a new instance. |
| Positioning | **Monitor & snap zone**, **Custom position**, or **Don't move the window**. The rows below it change to match the mode. |
| Monitor / Zone | Zone mode only: which display and which zone. Refresh the Monitor list after plugging in a new display. |
| X/Y/Width/Height + Capture | Custom mode only: the exact window rectangle. Filled by Capture, editable by hand. |
| Wait (seconds) | How long to wait for the window after launching (default 10) — raise it for slow-starting apps. |

Keys configured with an older version of the plugin keep working unchanged — they show up as **Custom position** with their captured rectangle intact.

## How it works

- **Snap zones**: the monitor and its work area are resolved at key-press time via `EnumDisplayMonitors`, so nothing goes stale when the display layout changes. Modern Windows windows carry invisible resize borders (`GetWindowRect` extends ~7 DPI-scaled pixels past the visible frame on the left, right, and bottom); the plugin measures each window's actual borders via DWM extended frame bounds and compensates, so the *visible* window edges land flush with the zone — pixel-identical to native Windows Snap.
- **Custom positions**: every PowerShell invocation opts into per-monitor-v2 DPI awareness, so capture and restore both use physical pixels in virtual-desktop coordinates — captured rectangles round-trip exactly across mixed-DPI monitor setups. If Windows rescales the window while it crosses onto a monitor with a different scale factor, the script verifies the final rectangle and reapplies once. Captured numbers include the invisible borders, so they read a few pixels larger than the visible frame — that's expected, and restoring them reproduces the visible layout exactly.
- **Store / UWP apps**: launched by AppUserModelId through the shell (their exes under `WindowsApps` are ACL-protected). Windows are matched by app package, so launcher stubs like `WhatsApp.Root.exe` spawning `WhatsApp.exe` still resolve, and the plugin repositions the `ApplicationFrameHost` frame that actually hosts UWP windows. Bare `WindowsApps` exe paths from old configs are converted to the package identity automatically.

## Project layout

```
StreamDeckWindowResize\
├── src\                                  TypeScript plugin source
│   ├── plugin.ts                         entry point, registers the action
│   ├── settings.ts                       key settings type + normalization/migration
│   ├── powershell.ts                     PowerShell script builders + runner
│   └── actions\launch-app.ts             the Launch & Position action
├── tests\                                node:test suite (zone math, monitors, settings)
├── com.myorg.window-launcher.sdPlugin\   the plugin bundle Stream Deck loads
│   ├── manifest.json                     plugin metadata (name, version, UUID)
│   ├── ui\launch.html                    Property Inspector (key settings UI)
│   ├── imgs\                             icons
│   └── bin\plugin.js                     build output (generated — don't edit)
├── package.json / rollup.config.mjs / tsconfig.json
└── com.myorg.window-launcher.streamDeckPlugin   packed release (generated)
```

## Development

Prerequisites: Windows 10/11, Stream Deck software 7.1+, Node.js 24+, and the Elgato CLI (`npm i -g @elgato/cli`).

First-time setup — install dependencies, build, and link the plugin folder into Stream Deck (creates a junction, so Stream Deck always runs what you build):

```bash
npm install
npm run build
streamdeck link com.myorg.window-launcher.sdPlugin
```

After that, deploying a change is just:

```bash
npm run build
streamdeck restart com.myorg.window-launcher
```

Or use `npm run watch`, which rebuilds on save and restarts the plugin automatically.

Run the tests with:

```bash
npm test
```

The suite runs the plugin's actual embedded PowerShell (zone math against real work-area rectangles, live monitor enumeration, settings migration), so it takes ~20 seconds and must run on Windows. The `tests/**/*.test.ts` glob in the test script is deliberate — `node --test tests/` (bare directory) does not work here.

Logs live in `com.myorg.window-launcher.sdPlugin/logs/`.

## Packaging a release

```bash
npm run build
streamdeck pack com.myorg.window-launcher.sdPlugin
```

This produces `com.myorg.window-launcher.streamDeckPlugin` in the project root — that file is the installer to share; double-clicking it on another machine installs the plugin.

⚠️ Don't double-click the packed file on **this** machine while the dev version is linked — it's the same UUID and Stream Deck will refuse (or fight the link). Unlink first if you want to test the packed install here.

Before publishing:

1. Bump the version in `com.myorg.window-launcher.sdPlugin/manifest.json` (`Version`, four segments, e.g. `1.2.0.0`) and keep `package.json`'s `version` in step.
2. Replace the placeholder UUID `com.myorg.window-launcher` with your own reverse-DNS identifier **everywhere** — it is permanent once published:
   - `manifest.json` → `UUID` and the action's `UUID`
   - `src/actions/launch-app.ts` → the `@action({ UUID: … })` decorator
   - the `.sdPlugin` folder name, `rollup.config.mjs` → `sdPlugin` constant, and the `streamdeck restart` name in `package.json`
3. Set `Nodejs.Debug` to `"disabled"` in `manifest.json` and lower the log level in `src/plugin.ts` (it's `debug` for development).
4. Test on a real device — at minimum the key press (launch, focus, reposition) for a zone key and a custom key, plus the Capture button, for both a classic app and a Store app.

## Troubleshooting

- **Nothing moves / access denied**: elevated (run-as-administrator) windows can't be repositioned by a non-elevated process (UIPI), and they don't appear in the Running apps list. Launch such apps unelevated, or run the Stream Deck software elevated (not generally recommended).
- **Monitor missing from the dropdown**: click the refresh icon next to the Monitor list — it's populated when the settings panel opens, so displays plugged in afterwards need a refresh.
- **Window snaps to the wrong display**: "Primary monitor" follows Windows' current primary. If you want a key pinned to a physical display, pick its numbered entry instead.
- **Store app window isn't found**: set **Process name** to the app's windowed process. The old `explorer.exe` + `shell:AppsFolder\…`-in-Arguments workaround from earlier versions also still works.
- **Window ends up a slightly different size**: some apps (Chromium-based ones especially) clamp or restore their own geometry after startup. Re-capture after the app settles, or increase **Wait (seconds)**. A few apps with fixed-size or custom-drawn windows can't fill a zone exactly.
- **Timed out waiting for a window**: slow-starting apps need a larger **Wait (seconds)**; splash-screen apps sometimes need a **Title contains** filter so the real window is matched.
- **Capture errors**: the app must be running with a visible (not minimized) window when you click Capture.
- **Offline machines**: the Property Inspector loads `sdpi-components` from its CDN. If offline, download `sdpi-components.js` into `ui/` and change the `<script src>` in `ui/launch.html` to the local file.
