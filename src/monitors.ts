import type { MonitorEntry } from "./platform";

/** One monitor as the Property Inspector needs it: geometry plus a display label. */
export type MonitorItem = {
	value: string;
	label: string;
	/** Arrangement position, shown inside the monitor rectangle. */
	index: number;
	left: number;
	top: number;
	width: number;
	height: number;
	isPrimary: boolean;
};

/**
 * Maps raw monitor geometry to Property Inspector items: sorted by arrangement
 * position and labelled like "Monitor 2 — 1920×1080 (primary)". Bounds are
 * passed through so the PI can draw the arrangement to scale.
 *
 * Labels come from the backend-supplied index rather than the device name:
 * only Windows device names happen to end in a small ordinal, while macOS
 * display ids are opaque numbers like 724043442.
 */
export function toMonitorItems(monitors: MonitorEntry[]): MonitorItem[] {
	return [...monitors]
		.sort((a, b) => a.index - b.index)
		.map((m) => {
			return {
				value: m.deviceName,
				label: `Monitor ${m.index} — ${m.width}×${m.height}${m.isPrimary ? " (primary)" : ""}`,
				index: m.index,
				left: m.left,
				top: m.top,
				width: m.width,
				height: m.height,
				isPrimary: m.isPrimary,
			};
		});
}
