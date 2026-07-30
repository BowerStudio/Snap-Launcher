# Visual window-position picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Monitor and Zone dropdowns in the Launch action's Property Inspector with a visual picker — a to-scale monitor arrangement (plus a synced Display dropdown) and a single interactive screen where the user aims at a region to choose one of the existing 9 snap zones.

**Architecture:** UI-only change plus one plugin-side data enrichment. Pure, testable helpers (`zoneFromPoint`, `zoneRect`, `layoutMonitors` in a new browser ES module; `toMonitorItems` in a new plugin module) carry the logic; thin DOM glue wires them to `SDPIComponents.streamDeckClient`. The 9 zones, settings schema, and all PowerShell positioning logic are untouched.

**Tech Stack:** TypeScript (plugin, built by rollup → `bin/plugin.js`), plain HTML + ES-module JavaScript for the Property Inspector (sdpi-components v4 from CDN), Node's built-in test runner (`node:test`).

## Global Constraints

- Platform: Windows-only Stream Deck plugin; Node 24 runtime.
- Test runner: `node --test tests/**/*.test.ts` (uses `node:test` + `node:assert/strict`). Test/import specifiers use explicit extensions (`../src/x.ts`, `../com.bowerstudio.snap-launcher.sdPlugin/ui/x.js`) and forward slashes.
- Keep the 9 zones exactly: `full`, `left`, `right`, `top`, `bottom`, `topLeft`, `topRight`, `bottomLeft`, `bottomRight`. Do NOT change `src/settings.ts`, `src/powershell.ts`, or any PowerShell.
- The Property Inspector is plain HTML/JS with no bundler. Integrate via `SDPIComponents.streamDeckClient`: `getSettings()` → `Promise<{ settings, ... }>` (settings are under `.settings`); `setSettings(value)` (fire-and-forget, pass the FULL settings object); `send('sendToPlugin', payload)`; `sendToPropertyInspector.subscribe(cb)` where `cb.payload` is the plugin message.
- Only touch the Launch action PI (`ui/launch.html`) and `src/actions/launch-app.ts`. The Close action is unchanged.
- Dark PI theme; accent/selection blue is `#1a8cff`, matching existing PI styles (borders `#4a4a4a`–`#565656`, muted text `#8a8a8a`–`#9a9a9a`).
- Every commit message must end with the trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## File Structure

- Create `com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js` — browser ES module. Exports pure helpers `ZONE_RECTS`, `zoneRect`, `zoneFromPoint`, `layoutMonitors`, and (added in Task 4) `init`; a guarded bottom block runs `init` in the browser only.
- Create `src/monitors.ts` — plugin module. Exports `MonitorItem` type and pure `toMonitorItems(monitors)`.
- Create `tests/position-picker.test.ts` — unit tests for the browser module's pure helpers.
- Create `tests/monitor-items.test.ts` — unit tests for `toMonitorItems`.
- Modify `src/actions/launch-app.ts` — `sendMonitors()` uses `toMonitorItems` and sends enriched geometry.
- Modify `com.bowerstudio.snap-launcher.sdPlugin/ui/launch.html` — replace the two `.zone-only` dropdown rows with the picker markup; load `position-picker.js`.

---

### Task 1: Zone hit-testing helpers (`zoneFromPoint`, `zoneRect`)

**Files:**
- Create: `com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js`
- Test: `tests/position-picker.test.ts`

**Interfaces:**
- Produces:
  - `ZONE_RECTS: Record<string, {left:number,top:number,width:number,height:number}>` — each zone's rectangle as percentages (0–100) of the screen box.
  - `zoneRect(zone: string): {left,top,width,height}` — `ZONE_RECTS[zone]`, falling back to `full`.
  - `zoneFromPoint(rx: number, ry: number): string` — maps a point (fractions 0–1) to one of the 9 zone keys; edge band `0.30`.

- [ ] **Step 1: Write the failing test**

Create `tests/position-picker.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { zoneFromPoint, zoneRect } from "../com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js";

test("zoneFromPoint maps centre, edges, and corners", () => {
	assert.equal(zoneFromPoint(0.5, 0.5), "full");
	assert.equal(zoneFromPoint(0.1, 0.5), "left");
	assert.equal(zoneFromPoint(0.9, 0.5), "right");
	assert.equal(zoneFromPoint(0.5, 0.1), "top");
	assert.equal(zoneFromPoint(0.5, 0.9), "bottom");
	assert.equal(zoneFromPoint(0.1, 0.1), "topLeft");
	assert.equal(zoneFromPoint(0.9, 0.1), "topRight");
	assert.equal(zoneFromPoint(0.1, 0.9), "bottomLeft");
	assert.equal(zoneFromPoint(0.9, 0.9), "bottomRight");
});

test("zoneFromPoint edge band is 0.30", () => {
	assert.equal(zoneFromPoint(0.29, 0.5), "left");
	assert.equal(zoneFromPoint(0.31, 0.5), "full");
	assert.equal(zoneFromPoint(0.5, 0.71), "bottom");
	assert.equal(zoneFromPoint(0.5, 0.69), "full");
});

test("zoneRect returns percentage rects and falls back to full", () => {
	assert.deepEqual(zoneRect("full"), { left: 0, top: 0, width: 100, height: 100 });
	assert.deepEqual(zoneRect("right"), { left: 50, top: 0, width: 50, height: 100 });
	assert.deepEqual(zoneRect("bottomRight"), { left: 50, top: 50, width: 50, height: 50 });
	assert.deepEqual(zoneRect("nonsense"), zoneRect("full"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/position-picker.test.ts`
Expected: FAIL — `Cannot find module '.../position-picker.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js`:

```js
// Property Inspector helper for the visual window-position picker.
// Pure helpers are exported for unit tests; DOM wiring (Task 4) is guarded so
// importing this module in Node never touches the browser globals.

// Each zone as a rectangle in percentages (0-100) of the screen box. Mirrors the
// PowerShell Get-ZoneRect layout (halves and quarters split at the midpoint).
export const ZONE_RECTS = {
	full: { left: 0, top: 0, width: 100, height: 100 },
	left: { left: 0, top: 0, width: 50, height: 100 },
	right: { left: 50, top: 0, width: 50, height: 100 },
	top: { left: 0, top: 0, width: 100, height: 50 },
	bottom: { left: 0, top: 50, width: 100, height: 50 },
	topLeft: { left: 0, top: 0, width: 50, height: 50 },
	topRight: { left: 50, top: 0, width: 50, height: 50 },
	bottomLeft: { left: 0, top: 50, width: 50, height: 50 },
	bottomRight: { left: 50, top: 50, width: 50, height: 50 },
};

export function zoneRect(zone) {
	return ZONE_RECTS[zone] ?? ZONE_RECTS.full;
}

const EDGE = 0.3;

// Maps a point over the screen (rx, ry as fractions 0-1) to a zone: aim within
// EDGE of one side -> that half; near two sides -> the corner quarter; centre -> full.
export function zoneFromPoint(rx, ry) {
	const nl = rx < EDGE;
	const nr = rx > 1 - EDGE;
	const nt = ry < EDGE;
	const nb = ry > 1 - EDGE;
	if ((nl || nr) && (nt || nb)) {
		return (nt ? "top" : "bottom") + (nl ? "Left" : "Right");
	}
	if (nl) return "left";
	if (nr) return "right";
	if (nt) return "top";
	if (nb) return "bottom";
	return "full";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/position-picker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/position-picker.test.ts "com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js"
git commit -m "feat(pi): add zone hit-testing helpers for visual picker"
```

---

### Task 2: Monitor arrangement layout helper (`layoutMonitors`)

**Files:**
- Modify: `com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js`
- Test: `tests/position-picker.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `layoutMonitors(monitors, maxWidth = 200, maxHeight = 110)` where `monitors` is an array of `{ value, label, left, top, width, height, isPrimary }`. Returns `{ boxWidth, boxHeight, monitors: Array<{ value, label, isPrimary, x, y, w, h }> }` — scaled to fit `maxWidth`×`maxHeight`, preserving true relative positions and aspect. Empty input → `{ boxWidth: 0, boxHeight: 0, monitors: [] }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/position-picker.test.ts`:

```ts
import { layoutMonitors } from "../com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js";

const M = (over) => ({ value: "\\\\.\\DISPLAY1", label: "m", left: 0, top: 0, width: 1600, height: 900, isPrimary: false, ...over });

test("layoutMonitors returns empty box for no monitors", () => {
	assert.deepEqual(layoutMonitors([]), { boxWidth: 0, boxHeight: 0, monitors: [] });
});

test("layoutMonitors scales two side-by-side monitors to fit", () => {
	const r = layoutMonitors(
		[M({ value: "\\\\.\\DISPLAY1", left: 0, isPrimary: true }), M({ value: "\\\\.\\DISPLAY2", left: 1600 })],
		320,
		180,
	);
	assert.equal(r.boxWidth, 320);
	assert.equal(r.boxHeight, 90);
	assert.deepEqual({ x: r.monitors[0].x, y: r.monitors[0].y, w: r.monitors[0].w, h: r.monitors[0].h }, { x: 0, y: 0, w: 160, h: 90 });
	assert.deepEqual({ x: r.monitors[1].x, y: r.monitors[1].y, w: r.monitors[1].w, h: r.monitors[1].h }, { x: 160, y: 0, w: 160, h: 90 });
	assert.equal(r.monitors[0].isPrimary, true);
});

test("layoutMonitors keeps a negative-left monitor on the left and fits the box", () => {
	const r = layoutMonitors(
		[M({ value: "\\\\.\\DISPLAY1", left: -1280, width: 1280, height: 1024 }), M({ value: "\\\\.\\DISPLAY2", left: 0, width: 1920, height: 1080, isPrimary: true })],
		320,
		180,
	);
	assert.equal(r.monitors[0].x, 0, "leftmost monitor starts at x=0");
	assert.ok(r.monitors[1].x > r.monitors[0].x, "monitor to the right has a greater x");
	assert.ok(r.boxWidth <= 320 && r.boxHeight <= 180, "layout fits the bounds");
});

test("layoutMonitors preserves a portrait monitor's aspect", () => {
	const r = layoutMonitors([M({ width: 1080, height: 1920 })], 200, 200);
	assert.ok(r.monitors[0].h > r.monitors[0].w, "portrait stays taller than wide");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/position-picker.test.ts`
Expected: FAIL — `does not provide an export named 'layoutMonitors'`.

- [ ] **Step 3: Write minimal implementation**

Append to `com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js` (after `zoneFromPoint`):

```js
// Scales monitor geometry into a small strip, preserving true relative positions
// and aspect ratios, so the arrangement mirrors the real desktop layout.
export function layoutMonitors(monitors, maxWidth = 200, maxHeight = 110) {
	if (!Array.isArray(monitors) || monitors.length === 0) {
		return { boxWidth: 0, boxHeight: 0, monitors: [] };
	}
	let minLeft = Infinity;
	let minTop = Infinity;
	let maxRight = -Infinity;
	let maxBottom = -Infinity;
	for (const m of monitors) {
		minLeft = Math.min(minLeft, m.left);
		minTop = Math.min(minTop, m.top);
		maxRight = Math.max(maxRight, m.left + m.width);
		maxBottom = Math.max(maxBottom, m.top + m.height);
	}
	const spanW = maxRight - minLeft;
	const spanH = maxBottom - minTop;
	const scale = Math.min(maxWidth / spanW, maxHeight / spanH);
	return {
		boxWidth: Math.round(spanW * scale),
		boxHeight: Math.round(spanH * scale),
		monitors: monitors.map((m) => ({
			value: m.value,
			label: m.label,
			isPrimary: !!m.isPrimary,
			x: Math.round((m.left - minLeft) * scale),
			y: Math.round((m.top - minTop) * scale),
			w: Math.round(m.width * scale),
			h: Math.round(m.height * scale),
		})),
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/position-picker.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/position-picker.test.ts "com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js"
git commit -m "feat(pi): add monitor arrangement layout helper"
```

---

### Task 3: Enrich the `getMonitors` payload with geometry

**Files:**
- Create: `src/monitors.ts`
- Test: `tests/monitor-items.test.ts`
- Modify: `src/actions/launch-app.ts` (imports; `sendMonitors()` at lines ~123-144)

**Interfaces:**
- Consumes: `MonitorEntry` from `src/powershell.ts` (`{ deviceName, left, top, width, height, workLeft, workTop, workWidth, workHeight, isPrimary }`).
- Produces:
  - `MonitorItem = { value: string; label: string; left: number; top: number; width: number; height: number; isPrimary: boolean }`.
  - `toMonitorItems(monitors: MonitorEntry[]): MonitorItem[]` — sorted by trailing device number; label `Monitor N — W×H` with ` (primary)` appended for the primary; geometry passed through.

- [ ] **Step 1: Write the failing test**

Create `tests/monitor-items.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { toMonitorItems } from "../src/monitors.ts";
import type { MonitorEntry } from "../src/powershell.ts";

const mon = (over: Partial<MonitorEntry>): MonitorEntry => ({
	deviceName: "\\\\.\\DISPLAY1",
	left: 0,
	top: 0,
	width: 1920,
	height: 1080,
	workLeft: 0,
	workTop: 0,
	workWidth: 1920,
	workHeight: 1040,
	isPrimary: false,
	...over,
});

test("toMonitorItems sorts by device number and labels each monitor", () => {
	const items = toMonitorItems([
		mon({ deviceName: "\\\\.\\DISPLAY2", isPrimary: true }),
		mon({ deviceName: "\\\\.\\DISPLAY1", width: 2560, height: 1440 }),
	]);
	assert.equal(items.length, 2);
	assert.equal(items[0].value, "\\\\.\\DISPLAY1");
	assert.equal(items[0].label, "Monitor 1 — 2560×1440");
	assert.equal(items[1].value, "\\\\.\\DISPLAY2");
	assert.equal(items[1].label, "Monitor 2 — 1920×1080 (primary)");
});

test("toMonitorItems passes geometry through unchanged", () => {
	const items = toMonitorItems([mon({ deviceName: "\\\\.\\DISPLAY1", left: -1280, top: 200, width: 1280, height: 1024, isPrimary: true })]);
	assert.deepEqual(
		{ left: items[0].left, top: items[0].top, width: items[0].width, height: items[0].height, isPrimary: items[0].isPrimary },
		{ left: -1280, top: 200, width: 1280, height: 1024, isPrimary: true },
	);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/monitor-items.test.ts`
Expected: FAIL — `Cannot find module '.../src/monitors.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/monitors.ts`:

```ts
import type { MonitorEntry } from "./powershell";

/** One monitor as the Property Inspector needs it: geometry plus a display label. */
export type MonitorItem = {
	value: string;
	label: string;
	left: number;
	top: number;
	width: number;
	height: number;
	isPrimary: boolean;
};

/**
 * Maps raw monitor geometry to Property Inspector items: sorted by the trailing
 * device number and labelled like "Monitor 2 — 1920×1080 (primary)". Bounds are
 * passed through so the PI can draw the arrangement to scale.
 */
export function toMonitorItems(monitors: MonitorEntry[]): MonitorItem[] {
	return [...monitors]
		.sort((a, b) => a.deviceName.localeCompare(b.deviceName, undefined, { numeric: true }))
		.map((m) => {
			const n = /(\d+)$/.exec(m.deviceName)?.[1] ?? m.deviceName;
			return {
				value: m.deviceName,
				label: `Monitor ${n} — ${m.width}×${m.height}${m.isPrimary ? " (primary)" : ""}`,
				left: m.left,
				top: m.top,
				width: m.width,
				height: m.height,
				isPrimary: m.isPrimary,
			};
		});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/monitor-items.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire `sendMonitors` to use it**

In `src/actions/launch-app.ts`, add the import near the other `../` imports:

```ts
import { toMonitorItems, type MonitorItem } from "../monitors";
```

Replace the whole `sendMonitors` method body (currently building `{ label, value }` items and injecting a `"primary"` sentinel) with:

```ts
	/** Sends the connected monitors (geometry + label) to the Property Inspector. */
	private async sendMonitors(): Promise<void> {
		let items: MonitorItem[] = [];

		try {
			const monitors = await runPowerShell<MonitorEntry[]>(buildMonitorListScript(), 20_000);
			if (Array.isArray(monitors)) {
				items = toMonitorItems(monitors);
			}
		} catch (e) {
			logger.error(`Failed to list monitors: ${e instanceof Error ? e.message : String(e)}`);
		}

		await streamDeck.ui.sendToPropertyInspector({ event: "getMonitors", items });
	}
```

- [ ] **Step 6: Verify the build and full suite still pass**

Run: `npm run build`
Expected: rollup completes with no TypeScript errors (confirms the import and types resolve; `MonitorEntry` is still used, the old sort/regex is gone).

Run: `node --test tests/**/*.test.ts`
Expected: PASS. Note: `tests/monitors.test.ts` is an integration test that spawns PowerShell and needs a real Windows desktop; if run off-device it may fail to enumerate monitors — that is environmental, not a regression from this task.

- [ ] **Step 7: Commit**

```bash
git add src/monitors.ts tests/monitor-items.test.ts src/actions/launch-app.ts
git commit -m "feat: send monitor geometry to the property inspector"
```

---

### Task 4: Wire the picker into the Property Inspector (DOM + markup)

**Files:**
- Modify: `com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js` (add `init` + guarded bootstrap)
- Modify: `com.bowerstudio.snap-launcher.sdPlugin/ui/launch.html` (styles, markup, script tag)
- Test: `tests/position-picker.test.ts` (import-safety guard test)

**Interfaces:**
- Consumes: `zoneRect`, `zoneFromPoint`, `layoutMonitors` (Tasks 1-2); the `getMonitors` reply `{ event: "getMonitors", items: MonitorItem[] }` (Task 3); `SDPIComponents.streamDeckClient` (see Global Constraints).
- Produces: `init()` — idempotently wires the picker DOM; a bottom guard calls it in the browser only.

- [ ] **Step 1: Write the failing test (import safety)**

Append to `tests/position-picker.test.ts`:

```ts
import * as picker from "../com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js";

test("module imports in Node without touching the DOM, and exposes init", () => {
	assert.equal(typeof picker.init, "function");
	assert.equal(typeof picker.zoneFromPoint, "function");
	assert.equal(typeof picker.layoutMonitors, "function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/position-picker.test.ts`
Expected: FAIL — `does not provide an export named 'init'`.

- [ ] **Step 3: Add `init` and the guarded bootstrap**

Append to `com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js`:

```js
// Fits a screen box to the monitor aspect ratio within a max width/height.
function screenBox(width, height, maxW = 200, maxH = 150) {
	const aw = width || 16;
	const ah = height || 9;
	let w = maxW;
	let h = (w * ah) / aw;
	if (h > maxH) {
		h = maxH;
		w = (h * aw) / ah;
	}
	return { w: Math.round(w), h: Math.round(h) };
}

// Wires the visual picker to the Stream Deck client. Safe to call once the DOM
// is ready; a no-op if the expected elements or client are missing.
export function init() {
	const client = typeof window !== "undefined" && window.SDPIComponents && window.SDPIComponents.streamDeckClient;
	const displaySel = document.getElementById("pp-display");
	const monitorsEl = document.getElementById("pp-monitors");
	const screenEl = document.getElementById("pp-screen");
	const hlEl = document.getElementById("pp-highlight");
	if (!client || !displaySel || !monitorsEl || !screenEl || !hlEl) return;

	let monitors = [];
	let selectedZone = "full";
	let selectedMonitor = "primary";
	let hoverZone = null;

	function geomFor(value) {
		if (value === "primary") return monitors.find((m) => m.isPrimary) || monitors[0];
		return monitors.find((m) => m.value === value) || monitors.find((m) => m.isPrimary) || monitors[0];
	}

	function paint(zone) {
		const r = zoneRect(zone);
		hlEl.style.left = r.left + "%";
		hlEl.style.top = r.top + "%";
		hlEl.style.width = r.width + "%";
		hlEl.style.height = r.height + "%";
	}

	function renderScreen() {
		const g = geomFor(selectedMonitor);
		const box = screenBox(g && g.width, g && g.height);
		screenEl.style.width = box.w + "px";
		screenEl.style.height = box.h + "px";
		paint(hoverZone || selectedZone);
	}

	function renderMonitors() {
		const layout = layoutMonitors(monitors);
		monitorsEl.style.width = layout.boxWidth + "px";
		monitorsEl.style.height = layout.boxHeight + "px";
		monitorsEl.innerHTML = layout.monitors
			.map((m) => {
				const sel = selectedMonitor === "primary" ? m.isPrimary : m.value === selectedMonitor;
				const num = (/(\d+)$/.exec(m.value) || [])[1] || "";
				return (
					'<button type="button" class="pp-mon' +
					(sel ? " pp-mon-sel" : "") +
					'" data-value="' +
					m.value +
					'" style="left:' +
					m.x +
					"px;top:" +
					m.y +
					"px;width:" +
					m.w +
					"px;height:" +
					m.h +
					'px" title="' +
					m.label +
					'">' +
					num +
					"</button>"
				);
			})
			.join("");
	}

	function renderDropdown() {
		const opts = ['<option value="primary">Primary monitor</option>'].concat(
			monitors.map((m) => '<option value="' + m.value + '">' + m.label + "</option>"),
		);
		displaySel.innerHTML = opts.join("");
		displaySel.value = selectedMonitor;
	}

	function save() {
		client.getSettings().then((p) => {
			const cur = (p && p.settings) || {};
			client.setSettings({ ...cur, monitorId: selectedMonitor, zone: selectedZone });
		});
	}

	function pickMonitor(value) {
		selectedMonitor = value;
		displaySel.value = value;
		renderMonitors();
		renderScreen();
		save();
	}

	displaySel.addEventListener("change", () => pickMonitor(displaySel.value));
	monitorsEl.addEventListener("click", (e) => {
		const btn = e.target.closest("[data-value]");
		if (btn) pickMonitor(btn.getAttribute("data-value"));
	});
	screenEl.addEventListener("mousemove", (e) => {
		const b = screenEl.getBoundingClientRect();
		if (!b.width || !b.height) return;
		const rx = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width));
		const ry = Math.min(1, Math.max(0, (e.clientY - b.top) / b.height));
		hoverZone = zoneFromPoint(rx, ry);
		hlEl.classList.add("pp-preview");
		paint(hoverZone);
	});
	screenEl.addEventListener("mouseleave", () => {
		hoverZone = null;
		hlEl.classList.remove("pp-preview");
		paint(selectedZone);
	});
	screenEl.addEventListener("click", () => {
		if (!hoverZone) return;
		selectedZone = hoverZone;
		hlEl.classList.remove("pp-preview");
		paint(selectedZone);
		save();
	});

	client.getSettings().then((p) => {
		const s = (p && p.settings) || {};
		selectedZone = s.zone || "full";
		selectedMonitor = s.monitorId || "primary";
		renderDropdown();
		renderMonitors();
		renderScreen();
	});

	client.sendToPropertyInspector.subscribe((ev) => {
		const payload = ev && ev.payload;
		if (!payload || payload.event !== "getMonitors") return;
		monitors = Array.isArray(payload.items) ? payload.items : [];
		renderDropdown();
		renderMonitors();
		renderScreen();
	});

	client.send("sendToPlugin", { event: "getMonitors" });
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
}
```

- [ ] **Step 4: Run test + syntax check**

Run: `node --test tests/position-picker.test.ts`
Expected: PASS (import-safety test green; no DOM access at import time).

Run: `node --check "com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js"`
Expected: no output (valid syntax).

- [ ] **Step 5: Add PI styles**

In `com.bowerstudio.snap-launcher.sdPlugin/ui/launch.html`, inside the existing `<style>` block (after the `.hint` rule), add:

```css
			#pp-display {
				width: 100%;
				background: #3a3a3a;
				border: 1px solid #555;
				border-radius: 4px;
				color: #dcdcdc;
				font: 400 12px "Segoe UI", sans-serif;
				padding: 5px 8px;
			}
			.pp-block {
				display: flex;
				justify-content: center;
				margin: 10px 0;
			}
			.pp-monitors {
				position: relative;
			}
			.pp-mon {
				position: absolute;
				margin: 0;
				padding: 0;
				background: #3a3a3a;
				border: 1px solid #565656;
				border-radius: 3px;
				color: #8a8a8a;
				font: 500 11px/1 "Segoe UI", sans-serif;
				cursor: pointer;
			}
			.pp-mon:hover {
				border-color: #6a6a6a;
			}
			.pp-mon-sel {
				background: #0a3f6e;
				border: 2px solid #1a8cff;
				color: #cfe6ff;
			}
			.pp-screen {
				position: relative;
				background: #3a3a3a;
				border: 1px solid #565656;
				border-radius: 4px;
				cursor: pointer;
				overflow: hidden;
			}
			.pp-highlight {
				position: absolute;
				box-sizing: border-box;
				left: 0;
				top: 0;
				width: 100%;
				height: 100%;
				background: rgba(26, 140, 255, 0.3);
				border: 1px solid #1a8cff;
				pointer-events: none;
				transition: all 0.04s linear;
			}
			.pp-highlight.pp-preview {
				background: rgba(26, 140, 255, 0.18);
			}
```

- [ ] **Step 6: Replace the Monitor + Zone rows with the picker markup**

In `launch.html`, delete the two existing `.zone-only` rows — the `<sdpi-item label="Monitor" class="zone-only" hidden>…</sdpi-item>` block and the `<sdpi-item label="Zone" class="zone-only" hidden>…</sdpi-item>` block (currently the `monitorId` `sdpi-select` and the `zone` `sdpi-select`). Replace both with:

```html
			<div class="zone-only" hidden>
				<sdpi-item label="Display">
					<select id="pp-display"></select>
				</sdpi-item>

				<div class="pp-block">
					<div id="pp-monitors" class="pp-monitors" aria-label="Monitor arrangement"></div>
				</div>

				<div class="pp-block">
					<div id="pp-screen" class="pp-screen">
						<div id="pp-highlight" class="pp-highlight"></div>
					</div>
				</div>
				<div class="hint">Aim at an edge for a half, a corner for a quarter, the centre for full screen.</div>
			</div>
```

- [ ] **Step 7: Load the module**

In `launch.html`, immediately before the closing `</body>` tag (after the existing inline `<script>` that runs `applyVisibility`), add:

```html
		<script type="module" src="position-picker.js"></script>
```

- [ ] **Step 8: Commit**

```bash
git add "com.bowerstudio.snap-launcher.sdPlugin/ui/position-picker.js" "com.bowerstudio.snap-launcher.sdPlugin/ui/launch.html" tests/position-picker.test.ts
git commit -m "feat(pi): replace zone/monitor dropdowns with a visual picker"
```

---

### Task 5: Full verification and manual QA

**Files:** none (verification only).

- [ ] **Step 1: Run the whole unit suite**

Run: `node --test tests/**/*.test.ts`
Expected: `position-picker.test.ts`, `monitor-items.test.ts`, and `settings.test.ts` PASS. The PowerShell integration tests (`monitors.test.ts`, `zone-helpers.test.ts`, `installed-apps.test.ts`, `close-settings.test.ts`, `virtual-desktop.test.ts`) require a live Windows desktop; on a dev machine they should pass, off-device their spawn failures are environmental.

- [ ] **Step 2: Build the plugin**

Run: `npm run build`
Expected: rollup completes with no errors.

- [ ] **Step 3: Load in Stream Deck and manually verify**

Reload the plugin (`streamdeck restart com.bowerstudio.snap-launcher`, or run `npm run watch`). Add a "Launch & Position" key, open its settings, set Positioning to "Monitor & snap zone", and confirm:

- The Display dropdown lists "Primary monitor" plus each monitor with its resolution; the arrangement draws all monitors to scale in their real relative positions, with the selected one highlighted blue.
- Picking a monitor in the dropdown highlights it in the arrangement, and vice-versa; both persist.
- Hovering the screen previews the zone (edge → half, corner → quarter, centre → full); clicking commits it and the highlight stays.
- Reopening the key's settings restores the saved monitor + zone highlight.
- Switching Positioning to "Custom position" and "Don't move the window" still shows the correct rows; switching back to zone keeps the selection.
- Pressing the key launches and snaps the app to the chosen monitor + zone exactly as before (behaviour unchanged).

- [ ] **Step 4: Update the branch (no code changes)**

If everything passes, the feature branch `visual-position-picker` is ready. Follow superpowers:finishing-a-development-branch to decide how to integrate (e.g., open a PR). Optionally rebuild the distributable with the Stream Deck CLI if a new `.streamDeckPlugin` package is needed.

---

## Self-Review

**Spec coverage:**
- Visual monitor arrangement + synced Display dropdown → Task 4 (markup + `init`), fed by Task 3 geometry and Task 2 `layoutMonitors`. ✓
- Single-screen zone picker (edge/corner/centre, hover preview, click commit, persistent highlight, hint) → Task 4 `init` + Task 1 `zoneFromPoint`/`zoneRect`. ✓
- Only zone mode affected; positionMode / custom / none untouched → Task 4 keeps the `.zone-only` wrapper and the existing visibility poll; no other rows changed. ✓
- No PowerShell/settings/zone changes → confirmed; only `launch-app.ts` `sendMonitors` and PI files change. ✓
- Data flow via `SDPIComponents.streamDeckClient`, geometry via enriched `getMonitors` → Task 3 + Task 4. ✓
- Pure helpers unit-tested; DOM glue thin and import-safe → Tasks 1, 2, 3 tests + Task 4 guard test. ✓
- Fallbacks (single monitor, enumeration failure, missing saved monitor, unknown aspect) → `layoutMonitors`/`geomFor`/`screenBox` handle empty and missing cases; `sendMonitors` sends `[]` on failure; `zoneRect`/`geomFor` fall back. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code. ✓

**Type/name consistency:** `zoneFromPoint`, `zoneRect`, `ZONE_RECTS`, `layoutMonitors`, `init` (browser module); `MonitorItem`, `toMonitorItems` (plugin). The `getMonitors` reply shape `{ event, items }` matches between `sendMonitors` (Task 3) and the PI subscriber (Task 4). Monitor item fields (`value,label,left,top,width,height,isPrimary`) are consistent across Tasks 2, 3, 4. ✓
