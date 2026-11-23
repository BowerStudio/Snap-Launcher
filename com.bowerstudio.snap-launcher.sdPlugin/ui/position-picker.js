// Property Inspector helper for the visual window-position picker.
// Pure helpers are exported for unit tests; DOM wiring (below) is guarded so
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

// Where a centred width x height window lands on a monitor, as percentages of
// the screen box, or null when there is no usable size yet. Mirrors the
// backends' centred-rect maths (a window bigger than the screen is pinned to
// its top-left), clipped to the box. Drawn against the monitor's full bounds
// rather than its work area, which at preview scale is the same picture.
export function centredPreviewRect(monWidth, monHeight, width, height) {
	if (!(monWidth > 0 && monHeight > 0 && width > 0 && height > 0)) return null;
	const left = Math.max(0, (monWidth - width) / 2);
	const top = Math.max(0, (monHeight - height) / 2);
	return {
		left: (left / monWidth) * 100,
		top: (top / monHeight) * 100,
		width: (Math.min(width, monWidth) / monWidth) * 100,
		height: (Math.min(height, monHeight) / monHeight) * 100,
	};
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
			// Supplied by the plugin: only Windows device names end in a small
			// ordinal, while a macOS display id looks like 724043442.
			index: m.index,
			isPrimary: !!m.isPrimary,
			x: Math.round((m.left - minLeft) * scale),
			y: Math.round((m.top - minTop) * scale),
			w: Math.round(m.width * scale),
			h: Math.round(m.height * scale),
		})),
	};
}

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
	let placement = readPlacement();

	function geomFor(value) {
		if (value === "primary") return monitors.find((m) => m.isPrimary) || monitors[0];
		return monitors.find((m) => m.value === value) || monitors.find((m) => m.isPrimary) || monitors[0];
	}

	function paintRect(r) {
		hlEl.hidden = !r;
		if (!r) return;
		hlEl.style.left = r.left + "%";
		hlEl.style.top = r.top + "%";
		hlEl.style.width = r.width + "%";
		hlEl.style.height = r.height + "%";
	}

	function paint(zone) {
		paintRect(zoneRect(zone));
	}

	function renderScreen() {
		const g = geomFor(selectedMonitor);
		const box = screenBox(g && g.width, g && g.height);
		screenEl.style.width = box.w + "px";
		screenEl.style.height = box.h + "px";
		// Centring has no zone to pick: the screen only previews the window.
		screenEl.classList.toggle("pp-static", placement.centred);
		if (placement.centred) {
			hlEl.classList.remove("pp-preview");
			paintRect(g ? centredPreviewRect(g.width, g.height, placement.width, placement.height) : null);
		} else {
			paint(hoverZone || selectedZone);
		}
	}

	function renderMonitors() {
		const layout = layoutMonitors(monitors);
		monitorsEl.style.width = layout.boxWidth + "px";
		monitorsEl.style.height = layout.boxHeight + "px";
		monitorsEl.innerHTML = layout.monitors
			.map((m) => {
				const sel = selectedMonitor === "primary" ? m.isPrimary : m.value === selectedMonitor;
				const num = m.index == null ? "" : String(m.index);
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
		if (placement.centred) return;
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
		renderScreen();
	});
	screenEl.addEventListener("click", () => {
		if (placement.centred || !hoverZone) return;
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

	// The mode, the Centre checkbox and the size are sdpi components bound to
	// settings, which don't re-emit changes across their shadow DOM; follow
	// them with the same light poll launch.html uses for row visibility.
	setInterval(() => {
		const next = readPlacement();
		if (placementEquals(next, placement)) return;
		placement = next;
		renderScreen();
	}, 300);

	client.send("sendToPlugin", { event: "getMonitors" });
}

function componentValue(selector) {
	const el = document.querySelector(selector);
	return el ? el.value : undefined;
}

// What the screen box should show: a centred-window preview (custom mode with
// Centre ticked) or the zone picker.
function readPlacement() {
	const mode = componentValue('sdpi-select[setting="positionMode"]') || "custom";
	return {
		centred: mode === "custom" && componentValue('sdpi-checkbox[setting="centreOnDisplay"]') === true,
		width: Number(componentValue('sdpi-textfield[setting="width"]')) || 0,
		height: Number(componentValue('sdpi-textfield[setting="height"]')) || 0,
	};
}

function placementEquals(a, b) {
	return a.centred === b.centred && a.width === b.width && a.height === b.height;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
}
