# Changelog

All notable changes to the **Snap Launcher** Stream Deck plugin are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and the project aims
to follow [Semantic Versioning](https://semver.org/).

## [1.2.0] — 2026-08-01

### Added

- **macOS support.** Snap Launcher now runs on macOS 13+ as well as Windows, from a single
  cross-platform plugin. Both actions work the same way on either OS: launch or focus an app,
  snap its window to a zone or a captured rectangle across multiple displays, and close or
  force-quit it.
  - Apps are picked from `/Applications`, `/System/Applications`, and `~/Applications`
    (including one level of subfolders), or from anything with an open window, or by browsing
    for an `.app` bundle. Keys remember an app by its **bundle identifier**, so they keep
    working after the app is updated, renamed, or moved.
  - Displays are enumerated with their true arrangement, including displays placed above or
    to the left of the primary. Work areas exclude the menu bar and Dock, so a full-screen
    zone never covers either — including when the Dock auto-hides or is moved.
  - **Accessibility permission is required** to control windows. When it hasn't been granted,
    keys report exactly which permission is missing and where to grant it, instead of a raw
    scripting error. Granting it takes effect on the next key press, with no restart.
  - You are never asked to approve individual applications: apps are launched with `open` and
    their windows driven through System Events, so macOS asks once rather than
    "Stream Deck wants to control …" for every app you configure.

### Changed

- All OS work now goes through a platform backend interface, with the existing PowerShell
  implementation moved behind it unchanged. Windows behavior — including virtual desktops,
  Microsoft Store apps, DPI handling, and invisible-border compensation — is unaffected, and
  existing keys keep working with their saved settings untouched.
- The Property Inspector adapts to the host platform: the **Virtual desktop** section is
  hidden on macOS (Spaces expose no public API for it), the file browser offers the right
  file types for the platform, and platform-specific help text is swapped. A virtual-desktop
  value configured on Windows is preserved, not cleared, when the key is opened on a Mac.
- Monitors are labelled from their arrangement position rather than their device name, since
  macOS display identifiers are opaque numbers.

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
