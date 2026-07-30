# Visual window-position picker — design

Date: 2026-07-30
Status: Approved (brainstorm), pending implementation plan

## Summary

Replace the two dropdowns used to choose a window position (Monitor + Zone) in
the Launch action's Property Inspector with a visual picker, modelled on the
Windows Snap Layouts / FancyZones experience:

- A **visual monitor arrangement** — every monitor drawn to scale in its true
  relative position — plus a **Display dropdown** kept in sync with it.
- A **single interactive screen** where the user aims at a region: edge → half,
  corner → quarter, centre → full. Hover previews the zone; click commits it.

The change is confined to the Property Inspector (UI) plus one small enrichment
of the data the plugin already sends. The 9 zones, the settings schema, the
positioning logic, and the PowerShell scripts are unchanged.

## Motivation

Choosing "Top-right quarter" from a text dropdown is abstract. A picture of the
screen with the target region highlighted is immediately understandable and
matches how users think about window snapping.

## Scope

### In scope

- Launch action Property Inspector (`com.bowerstudio.snap-launcher.sdPlugin/ui/launch.html`).
- A new Property Inspector module: `com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js`.
- A new plugin-side module `src/monitors.ts` holding the pure `toMonitorItems`
  mapping, and enriching the `getMonitors` message payload sent by
  `src/actions/launch-app.ts` so the PI receives per-monitor geometry.
- Unit tests (Node's built-in `node:test` runner) for the pure helper functions.

### Explicitly out of scope

- No new zone types. The 9 zones stay: `full`, `left`, `right`, `top`,
  `bottom`, `topLeft`, `topRight`, `bottomLeft`, `bottomRight`.
- No change to `zone` / `monitorId` settings, to `toConfig()` / `toCloseConfig()`
  in `src/settings.ts`, or to any PowerShell in `src/powershell.ts` — including
  `buildMonitorListScript`, which already returns full geometry.
- No change to the Close action (it has no positioning settings).
- No change to `positionMode` (zone / custom / none) or to the Custom and None
  sections of the PI.

## Current behaviour (reference)

In `launch.html`, the "Window position" section shows a `positionMode` select.
When `positionMode === "zone"`, two rows (class `zone-only`) appear:

- **Monitor** — an `sdpi-select` bound to `monitorId`, populated by the
  `getMonitors` datasource. Values are `"primary"` or a device name
  (e.g. `\\.\DISPLAY2`).
- **Zone** — an `sdpi-select` bound to `zone` listing the 9 zones.

Visibility of `.zone-only` / `.custom-only` rows is driven by a 300ms poll in the
inline script, because `sdpi-select` does not re-emit change events across its
shadow DOM.

`getMonitors` is handled by `LaunchApp.onSendToPlugin` →
`LaunchApp.sendMonitors()`, which runs `buildMonitorListScript()`. That script
returns `MonitorEntry[]` with `deviceName, left, top, width, height,
workLeft, workTop, workWidth, workHeight, isPrimary`. `sendMonitors()` currently
**discards the geometry**, sending only `{ label, value }` items to the PI.

## Design

### 1. Property Inspector layout (zone mode only)

Within the existing `.zone-only` block, replace the Monitor and Zone
`sdpi-select` rows with a container the picker owns:

1. **Display dropdown** — a native `<select>` populated from the monitor list.
   Options: a leading `Primary monitor` entry (value `"primary"`, the default),
   then one entry per monitor labelled like `Monitor 2 — 1920×1080 (primary)`.
   Writes `monitorId`.
2. **Monitor arrangement** — all monitors drawn to scale in their true relative
   positions. The selected monitor is highlighted (blue); others are muted.
   Clicking a monitor selects it. Kept in sync with the dropdown.
3. **Zone picker (single screen)** — one rectangle drawn to the selected
   monitor's aspect ratio.
   - On `mousemove`, compute the region under the cursor and show a translucent
     blue preview of that zone's rectangle.
   - On `mouseleave`, revert the preview to the currently-saved zone.
   - On `click`, commit the hovered zone to settings.
   - The saved zone is always rendered as a solid highlight so current state is
     visible without hovering.
   - A one-line hint ("Aim at an edge for a half, a corner for a quarter, the
     centre for full screen") makes the interaction discoverable.

The `positionMode` selector and the Custom / None rows are unchanged. The
existing 300ms visibility poll continues to govern when the `.zone-only` block is
shown; the picker initialises once and reads/writes settings independently of
that poll.

### 2. Zone hit-testing

Given cursor position as fractions `rx, ry` in `[0, 1]` over the screen
rectangle, with an edge band threshold `T = 0.30`:

```
nearLeft   = rx < T
nearRight  = rx > 1 - T
nearTop    = ry < T
nearBottom = ry > 1 - T

if ((nearLeft || nearRight) && (nearTop || nearBottom))  -> corner quarter
else if nearLeft   -> "left"
else if nearRight  -> "right"
else if nearTop    -> "top"
else if nearBottom -> "bottom"
else               -> "full"
```

The corner quarter is `(nearTop ? "top" : "bottom") + (nearLeft ? "Left" : "Right")`,
yielding `topLeft` / `topRight` / `bottomLeft` / `bottomRight`.

Each zone maps to a rectangle within the screen box (percentages of width/height):
`full` = whole; `left`/`right` = 50% width halves; `top`/`bottom` = 50% height
halves; the four quarters = 50%×50% corners. This is used both to draw the
highlight and is the visual counterpart of the PowerShell `Get-ZoneRect`.

### 3. Monitor arrangement scaling

A pure helper `layoutMonitors(monitors)` takes the geometry array and returns,
for each monitor, a scaled rectangle `{ value, label, isPrimary, x, y, w, h }`
positioned inside a fixed-width strip:

- Compute the bounding box of all monitors from `left/top/width/height`.
- Choose a scale so the bounding box fits the strip's max width (and a max
  height cap), preserving aspect ratio.
- Translate so the bounding box's top-left maps to `(0, 0)`.

This keeps relative positions and sizes faithful (a portrait monitor renders
portrait; a monitor left of primary renders to the left).

### 4. Data flow & plugin change

- **Read on load:** the picker asks `SDPIComponents.streamDeckClient` for the
  current settings and restores the selected monitor and highlighted zone.
- **Write on click:** merge the new `zone` or `monitorId` into the current
  settings and `setSettings`, so unrelated fields are preserved.
- **Monitor geometry:** the mapping of `MonitorEntry[]` to PI items is extracted
  into a pure, exported `toMonitorItems(monitors)` in a new `src/monitors.ts`
  (so it can be unit-tested). `LaunchApp.sendMonitors()` calls it and sends the
  result, which now includes geometry. `value` and `label` are retained for the
  PI's Display dropdown. Item shape:

  ```ts
  { value: string; label: string; left: number; top: number;
    width: number; height: number; isPrimary: boolean }
  ```

  The `sdpi-select` Monitor dropdown is removed (replaced by the picker's own
  Display dropdown), so the old `{label,value}`-only datasource shape and the
  server-injected `"primary"` sentinel item are no longer needed; the picker
  adds the `Primary monitor` (value `"primary"`) option itself. When
  `monitorId === "primary"`, the arrangement highlights whichever monitor has
  `isPrimary === true`.

The picker requests the monitor list via the existing `getMonitors`
`sendToPlugin` event and listens for the `getMonitors` reply. No new message
types are required.

### 5. Code structure

`position-picker.js` is a browser ES module loaded by `launch.html` via
`<script type="module" src="position-picker.js"></script>`:

- **Pure, exported, side-effect-free:** `zoneFromPoint(rx, ry)`,
  `zoneRect(zone)`, `layoutMonitors(monitors)`, and a `monitorLabel(monitor)`
  helper. These have no dependency on `document` or `SDPIComponents`.
- **DOM wiring:** an `init()` that runs only in the browser (guarded, e.g.
  `if (typeof document !== "undefined")` and on `DOMContentLoaded`), wiring the
  arrangement, dropdown, and screen to the pure helpers and the Stream Deck
  client.

No bundler change is needed: the plugin build (`rollup`) targets `src/plugin.ts`
only; the PI HTML/JS is served as-is by Stream Deck, and Node's built-in test
runner (`node --test`) imports the pure ESM helpers directly (forward-slash
specifier, `.js` extension).

### 6. Fallbacks & edge cases

- **Single monitor:** arrangement shows one tile; zone picker uses it.
- **Monitor enumeration fails / empty:** fall back to a single generic 16:9
  screen and the `Primary monitor` default; the Display dropdown stays usable.
- **Saved `monitorId` no longer present** (monitor unplugged): fall back to
  highlighting the primary monitor visually; the stored value is left intact so
  it still resolves if the monitor returns. (Positioning already tolerates a
  missing monitor by falling back to primary in PowerShell.)
- **Aspect ratio unknown before geometry arrives:** render the screen at 16:9
  until the monitor list resolves, then re-render to the real ratio.

## Testing

- Unit tests (`node:test`) for `zoneFromPoint` — every region including the four
  corners, the four edge midpoints, and the centre, plus band boundaries.
- Unit tests for `zoneRect` — each zone maps to the expected rectangle.
- Unit tests for `layoutMonitors` — relative positions and scaling preserved for
  a representative multi-monitor arrangement (including a monitor with negative
  `left`, i.e. left of primary, and a portrait monitor); single-monitor case.
- Unit tests for `toMonitorItems` — sorting by device number, label formatting
  (including the `(primary)` suffix), and geometry passthrough.
- Importing `position-picker.js` in Node must not throw (DOM/`SDPIComponents`
  wiring is guarded), proving the pure/side-effect split holds.
- Existing tests (`settings.test.ts`, `monitors.test.ts`, `zone-helpers.test.ts`,
  etc.) must continue to pass unchanged.
- Manual check in Stream Deck: pick monitor via arrangement and via dropdown
  (in sync); hover previews the right zone; click persists; reopening the PI
  restores the highlight; Custom and None modes still behave as before.

## Non-goals / future ideas

- Configurable custom grids or additional templates (thirds, columns).
- Making the zone picker keyboard-navigable (the PI is mouse-driven today).
- Applying the visual picker to any future action that gains positioning.
