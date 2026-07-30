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
