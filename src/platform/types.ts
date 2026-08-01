/**
 * Data shapes shared by every platform backend. These are the contract between
 * the actions and whichever OS implementation is serving them: an action that
 * consumes a LaunchResult must not be able to tell which platform produced it.
 */

export type PositionMode = "none" | "zone" | "custom";

/**
 * Configuration passed into a backend's launch/capture operations. All fields
 * are normalized (trimmed strings, clamped numbers, validated mode/zone) by
 * toConfig() in settings.ts before reaching a backend.
 */
export type LaunchConfig = {
	/**
	 * Opaque per-platform application identity. Windows: an exe/.lnk path or
	 * "shell:AppsFolder\<AUMID>". macOS: an .app bundle path or bundle id.
	 */
	appPath: string;
	launchArgs: string;
	titleFilter: string;
	processName: string;
	focusIfRunning: boolean;
	/** How to position the window after launch/focus. */
	positionMode: PositionMode;
	/** Opaque display key from MonitorEntry.deviceName, or "primary". Zone mode only. */
	monitorId: string;
	/** One of the 9 snap zones. Zone mode only. */
	zone: string;
	waitSeconds: number;
	/** Explicit rectangle. Custom mode only. */
	x: number;
	y: number;
	width: number;
	height: number;
	/**
	 * Virtual desktop to run the app on (created if missing, switched to on
	 * press). A desktop name, matched case-insensitively; "Desktop N" targets
	 * the Nth desktop. Empty = current desktop (feature off).
	 *
	 * Only meaningful where features.virtualDesktop is true; backends that
	 * declare it unsupported ignore this rather than failing the press.
	 */
	virtualDesktop: string;
};

export type LaunchResult =
	| { ok: true; launched: boolean; positioned: boolean; movedDesktop: boolean; pid: number; title: string }
	| { ok: false; error: string };

export type CloseMode = "close" | "closeThenKill" | "kill";

/**
 * Configuration for the Close App action. appPath/titleFilter/processName
 * identify windows exactly like LaunchConfig does.
 */
export type CloseConfig = {
	appPath: string;
	titleFilter: string;
	processName: string;
	closeMode: CloseMode;
	/** closeThenKill only: grace period before force-quitting. */
	waitSeconds: number;
};

export type CloseResult =
	| { ok: true; found: number; closed: number; killed: number }
	| { ok: false; error: string };

export type CaptureResult =
	| { ok: true; x: number; y: number; width: number; height: number; title: string; maximized: boolean }
	| { ok: false; error: string };

export type RunningApp = { name: string; title: string; path: string | null; display?: string };

export type InstalledApp = { name: string; path: string };

/**
 * One connected display. Coordinates are in a single global space whose origin
 * is the top-left of the primary display, y increasing downward — physical
 * pixels on Windows, points on macOS. Both platforms capture and re-apply
 * rectangles in their own space, so the two never need comparing.
 */
export type MonitorEntry = {
	/**
	 * Opaque, stable per-platform key, persisted as a key's monitorId.
	 * Windows: "\\.\DISPLAY2". macOS: the CGDirectDisplayID as a string.
	 * Never parsed for display purposes — see `index`.
	 */
	deviceName: string;
	/**
	 * 1-based position in the system's display arrangement, used for labelling.
	 * Separate from deviceName because only Windows device names happen to
	 * carry a small ordinal.
	 */
	index: number;
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
