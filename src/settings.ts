import type { CloseConfig, CloseMode, LaunchConfig, PositionMode } from "./powershell";

/**
 * Per-key settings. Numeric fields may arrive as strings (they are bound to
 * text fields in the Property Inspector) and are normalized in toConfig().
 */
export type LaunchSettings = {
	appPath?: string;
	/** Which app picker the PI shows (installed | running | browse). Cosmetic only. */
	appSource?: string;
	launchArgs?: string;
	titleFilter?: string;
	processName?: string;
	focusIfRunning?: boolean;
	/** Legacy pre-zone setting; superseded by positionMode but read for migration. */
	applyPosition?: boolean;
	positionMode?: string;
	/** Virtual desktop name to run the app on; empty/absent = current desktop. */
	virtualDesktop?: string;
	monitorId?: string;
	zone?: string;
	waitSeconds?: number | string;
	x?: number | string;
	y?: number | string;
	width?: number | string;
	height?: number | string;
	captureStatus?: string;
	/** App the key was last auto-titled for, and the title that was applied. */
	titledFor?: string;
	autoTitle?: string;
};

/**
 * Per-key settings for the Close App action. App identification fields mirror
 * LaunchSettings so the Property Inspector pickers are interchangeable.
 */
export type CloseSettings = {
	appPath?: string;
	/** Which app picker the PI shows (installed | running | browse). Cosmetic only. */
	appSource?: string;
	titleFilter?: string;
	processName?: string;
	/** close (default) | closeThenKill | kill */
	closeMode?: string;
	/** closeThenKill only: grace period before force-quitting. */
	waitSeconds?: number | string;
	/** Status line shown in the PI. */
	captureStatus?: string;
	/** App the key was last auto-titled for, and the title that was applied. */
	titledFor?: string;
	autoTitle?: string;
};

export const ZONES: readonly string[] = ["full", "left", "right", "top", "bottom", "topLeft", "topRight", "bottomLeft", "bottomRight"];

/** Coerces a possibly-string numeric setting; falls back when blank/invalid. */
function num(v: number | string | undefined, fallback: number): number {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return fallback;
}

/**
 * Normalizes settings into the config the PowerShell scripts expect.
 *
 * Mode resolution: an explicit positionMode wins; otherwise legacy keys are
 * migrated from applyPosition (true/absent → custom, false → none). Custom
 * mode without a valid captured rectangle degrades to none so a first press
 * still launches the app.
 */
/** Normalizes Close App settings into the config the close script expects. */
export function toCloseConfig(s: CloseSettings): CloseConfig {
	const mode: CloseMode = s.closeMode === "closeThenKill" || s.closeMode === "kill" ? s.closeMode : "close";
	return {
		appPath: (s.appPath ?? "").trim(),
		titleFilter: (s.titleFilter ?? "").trim(),
		processName: (s.processName ?? "").trim(),
		closeMode: mode,
		waitSeconds: Math.min(60, Math.max(1, Math.round(num(s.waitSeconds, 5)))),
	};
}

export function toConfig(s: LaunchSettings): LaunchConfig {
	const x = num(s.x, Number.NaN);
	const y = num(s.y, Number.NaN);
	const width = num(s.width, 0);
	const height = num(s.height, 0);
	const hasRect = Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0;

	let mode: PositionMode;
	if (s.positionMode === "none" || s.positionMode === "zone" || s.positionMode === "custom") {
		mode = s.positionMode;
	} else {
		mode = (s.applyPosition ?? true) ? "custom" : "none";
	}
	if (mode === "custom" && !hasRect) {
		mode = "none";
	}

	const zone = ZONES.includes(s.zone ?? "") ? (s.zone as string) : "full";

	return {
		appPath: (s.appPath ?? "").trim(),
		launchArgs: (s.launchArgs ?? "").trim(),
		titleFilter: (s.titleFilter ?? "").trim(),
		processName: (s.processName ?? "").trim(),
		focusIfRunning: s.focusIfRunning ?? true,
		positionMode: mode,
		virtualDesktop: (s.virtualDesktop ?? "").trim(),
		monitorId: (s.monitorId ?? "").trim() || "primary",
		zone,
		waitSeconds: Math.min(120, Math.max(1, Math.round(num(s.waitSeconds, 10)))),
		x: hasRect ? Math.round(x) : 0,
		y: hasRect ? Math.round(y) : 0,
		width: hasRect ? Math.round(width) : 0,
		height: hasRect ? Math.round(height) : 0,
	};
}
