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
	 * Either platform additionally accepts "steam:<appid>" — see SteamTarget.
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

export type CloseResult = { ok: true; found: number; closed: number; killed: number } | { ok: false; error: string };

export type CaptureResult =
	| { ok: true; x: number; y: number; width: number; height: number; title: string; maximized: boolean }
	| { ok: false; error: string };

export type RunningApp = { name: string; title: string; path: string | null; display?: string };

export type InstalledApp = { name: string; path: string };

/**
 * Longest edge, in pixels, of the PNG a backend renders an app icon into.
 *
 * 144 is the largest key bitmap any Stream Deck draws, so nothing visible is
 * lost by capping here — and the PNG is persisted in the key's settings so it
 * can be re-applied without touching the disk again, which makes its size worth
 * minding.
 */
export const ICON_MAX_PX = 144;

/**
 * An application's own icon, found on disk and converted to something Stream
 * Deck can render: a shipped .ico on Windows, the bundle's .icns on macOS.
 */
export type AppIcon = {
	/** Absolute path of the icon file it was read from, for the PI's status line. */
	sourcePath: string;
	/** Pixel size of the frame that was used, before the downscale to ICON_MAX_PX. */
	width: number;
	height: number;
	/** The icon as a PNG data URI, ready to hand to Stream Deck's setImage(). */
	image: string;
};

/**
 * The outcome of looking for an application's icon. Finding none is a normal
 * result rather than a failure — plenty of apps ship no icon file at all — so
 * it carries its own explanation instead of an error.
 */
export type AppIconResult = { found: true; icon: AppIcon } | { found: false; reason: string };

/**
 * A "steam:<appid>" appPath resolved against the local Steam installation, and
 * passed to the platform scripts alongside the config. Resolved per operation
 * rather than persisted: a game can be moved between library folders, updated,
 * or uninstalled at any time, and the key must follow it.
 */
export type SteamTarget = {
	/** Steam's own application id, digits only. */
	appId: string;
	/** The game's name as Steam records it, for key titles and error messages. */
	name: string;
	/**
	 * Absolute directory the game's files live in, or "" when it is not
	 * installed. A Steam game's executable name is not knowable in advance, so
	 * its windows are recognized by their process living inside this directory
	 * — the same way Store apps are matched by their package location.
	 */
	installDir: string;
	/** The steam:// URL that starts the game, launch arguments included. */
	launchUrl: string;
};

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
