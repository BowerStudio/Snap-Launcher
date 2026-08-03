import { type AppIconResult } from "./types";

/**
 * Application icons, as both platforms' scripts report them.
 *
 * The two find their icon in completely different ways — a .ico somewhere under
 * the executable's folder on Windows, the .icns inside an .app bundle on macOS —
 * but they answer in the same shape, so turning that answer into an AppIconResult
 * is written once here rather than twice in the backends.
 */

/** The single JSON line an icon script emits. */
export type RawAppIcon = {
	ok?: boolean;
	/** Whether an icon file was found at all. */
	found?: boolean;
	/** Absolute path of the icon file that was read. */
	path?: string;
	/** Pixel size of the frame that was rendered, before any downscale. */
	width?: number;
	height?: number;
	/** The rendered PNG, base64 encoded without a data-URI prefix. */
	png?: string;
	/** Why nothing was found, when found is false. */
	reason?: string;
	/** Present only when the script itself failed. */
	error?: string;
};

/** Fallback wording for a script that reported neither an icon nor a reason. */
const UNKNOWN_REASON = "No icon file could be found for this app.";

/**
 * Interprets a script's reply. A script that failed outright throws, because
 * that is a real error the caller should log; everything else — including a
 * perfectly ordinary "this app ships no icon" — comes back as a result.
 */
export function toAppIconResult(raw: RawAppIcon | null | undefined): AppIconResult {
	if (!raw || typeof raw !== "object") {
		throw new Error("The icon lookup produced no usable result.");
	}
	if (raw.ok === false) {
		throw new Error(raw.error || "The icon lookup failed.");
	}

	// A truncated or half-written reply is a miss, not an icon: handing Stream
	// Deck an empty data URI would blank the key rather than leave it alone.
	if (raw.found !== true || typeof raw.png !== "string" || raw.png.length === 0) {
		return { found: false, reason: (raw.reason ?? "").trim() || UNKNOWN_REASON };
	}

	return {
		found: true,
		icon: {
			sourcePath: typeof raw.path === "string" ? raw.path : "",
			width: size(raw.width),
			height: size(raw.height),
			image: `data:image/png;base64,${raw.png}`,
		},
	};
}

/** Reported frame dimensions are decoration; anything unusable reads as 0. */
function size(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
