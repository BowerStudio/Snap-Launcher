import type { MonitorEntry } from "../types";
import { wrapScript } from "./scripts";

/**
 * Raw per-screen geometry as the JXA script reports it, already converted into
 * the top-left origin space. Kept separate from MonitorEntry so the pure
 * ordering/indexing step below can be tested without running osascript.
 */
export type RawScreen = {
	deviceName: string;
	left: number;
	top: number;
	width: number;
	height: number;
	workLeft: number;
	workTop: number;
	workWidth: number;
	workHeight: number;
	isPrimary: boolean;
};

/**
 * Enumerates NSScreen and converts it into the coordinate space the rest of the
 * plugin speaks.
 *
 * macOS has two coordinate systems: NSScreen is bottom-left origin with y
 * increasing upward, while the Accessibility API — which is what actually moves
 * windows — is top-left origin with y increasing downward, relative to the
 * top-left of the primary display. The second one is also exactly what the
 * plugin's zone math and captured rectangles already assume from Windows, so
 * the conversion happens once, here, and nothing downstream has to know.
 *
 * NSScreen.screens[0] is the display carrying the menu bar; its frame origin is
 * (0, 0) and it is the height everything else is flipped against.
 *
 * visibleFrame is the frame minus the menu bar and the Dock, which is precisely
 * the work area a maximizing zone must respect. It is live, so an auto-hidden
 * or relocated Dock is reflected without any special handling.
 *
 * Units are points, not backing pixels. Capture and apply both use points, so
 * rectangles round-trip exactly.
 */
export const DISPLAY_HELPERS = `
function listDisplays() {
        var screens = $.NSScreen.screens;
        // Number() because a bridged count arrives as a string: a strict === 0
        // never fires, and objectAtIndex(0) below would throw instead.
        var count = Number(screens.count);
        if (!count) return [];

        // screens[0] is the menu-bar display: the origin of the flipped space.
        var primaryFrame = screens.objectAtIndex(0).frame;
        var primaryTop = primaryFrame.origin.y + primaryFrame.size.height;

        function flip(frame) {
            return {
                left: Math.round(frame.origin.x),
                top: Math.round(primaryTop - (frame.origin.y + frame.size.height)),
                width: Math.round(frame.size.width),
                height: Math.round(frame.size.height)
            };
        }

        var out = [];
        for (var i = 0; i < count; i++) {
            var screen = screens.objectAtIndex(i);
            var bounds = flip(screen.frame);
            var work = flip(screen.visibleFrame);

            // NSScreenNumber is the CGDirectDisplayID: stable for as long as the
            // display stays connected, and opaque to everything downstream.
            var id = screen.deviceDescription.objectForKey('NSScreenNumber');
            var deviceName = id && !id.isNil() ? String(ObjC.unwrap(id.stringValue)) : ('screen-' + i);

            out.push({
                deviceName: deviceName,
                left: bounds.left,
                top: bounds.top,
                width: bounds.width,
                height: bounds.height,
                workLeft: work.left,
                workTop: work.top,
                workWidth: work.width,
                workHeight: work.height,
                isPrimary: i === 0
            });
        }
        return out;
}
`;

/** The displays operation is just the shared helper, serialised. */
export function buildDisplayListScript(): string {
	return wrapScript(`        return listDisplays();`, DISPLAY_HELPERS);
}

/**
 * Orders displays primary-first and assigns the 1-based arrangement index the
 * Property Inspector labels from. The script already emits them in NSScreen
 * order (primary first), but ordering is asserted here rather than assumed.
 */
export function toMonitorEntries(screens: RawScreen[]): MonitorEntry[] {
	if (!Array.isArray(screens)) {
		return [];
	}
	const ordered = [...screens].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
	return ordered.map((s, i) => ({ ...s, index: i + 1 }));
}
