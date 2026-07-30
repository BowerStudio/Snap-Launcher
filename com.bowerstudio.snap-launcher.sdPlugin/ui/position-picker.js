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
