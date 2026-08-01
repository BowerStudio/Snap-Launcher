# Changelog

All notable changes to the **Snap Launcher** Stream Deck plugin are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and the project aims
to follow [Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-07-30

### Added

- **Visual window-position picker.** On a _Launch & Position_ key, the **Window position**
  section's _Monitor & snap zone_ mode is now point-and-click instead of two dropdowns:
  - A **to-scale map of your monitors**, arranged just like your real desktop — click the
    display you want the window on. Portrait monitors, and displays placed to the left of or
    above the primary, are drawn in their true relative positions.
  - A **Display dropdown** that stays in sync with the map, so you can pick either way.
  - A **picture of the screen you aim at** to choose the zone: hover an **edge** for a half,
    a **corner** for a quarter, or the **centre** for full screen, then click. A live preview
    follows the cursor, and the saved zone stays highlighted.

  No more mapping "Top-right quarter" in your head — you see exactly where the window will go.

### Unchanged

- The nine snap zones and all window-positioning behaviour are identical, so **existing keys
  keep working with no reconfiguration**. This release only changes how you _choose_ the
  monitor and zone.

## [1.0.0] — Initial release

A Windows Stream Deck plugin that launches (or focuses) an app and snaps its window into place
with a single key press. Works with classic desktop apps (`.exe` / `.lnk`) and Microsoft Store
apps, across multi-monitor layouts — including monitors positioned to the left of or above the
primary (negative coordinates).

### Launch & Position

- Launch an app, or **focus and reposition** it if it's already running.
- **Snap zones** — full screen, left/right halves, top/bottom halves, or the four quarters —
  worked out against the monitor's work area on every press, so they survive resolution,
  scaling, and layout changes. Target any monitor, or "Primary monitor" to follow the current
  primary; a disconnected monitor falls back to the primary instead of failing.
- **Custom position** — capture an app's current window rectangle (or type X / Y / Width /
  Height) and restore it exactly, round-tripping across mixed-DPI monitors.
- **Don't move the window** — use the key as a plain launcher / focuser.
- **Virtual desktops (Windows 11)** — run the app on a named desktop, created and switched to
  on press; a window already open elsewhere is moved across.

### Close App

- Close an app's windows **gracefully** (like clicking ✕, so unsaved-work prompts still
  appear), **close then force-quit** after a grace period, or **force-quit immediately**.
- Pressing the key when the app isn't running counts as success.

### Choosing an app

- Pick from **Running apps**, **Installed apps** (Start Menu programs plus Microsoft Store
  packages), or **Browse for a file**. Keys auto-title with the app's name.

### Advanced

- **Title contains** and **Process name** filters for disambiguating multi-window apps.
