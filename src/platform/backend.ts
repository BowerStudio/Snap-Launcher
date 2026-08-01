import type {
	CaptureResult,
	CloseConfig,
	CloseResult,
	InstalledApp,
	LaunchConfig,
	LaunchResult,
	MonitorEntry,
	RunningApp,
} from "./types";

/**
 * Optional capabilities a backend may or may not provide. Consumers ask the
 * backend rather than checking the platform name, so adding a platform never
 * means hunting down process.platform checks.
 */
export type PlatformFeatures = {
	/** Whether LaunchConfig.virtualDesktop is honored (Windows) or ignored (macOS). */
	readonly virtualDesktop: boolean;
};

/**
 * The complete set of OS operations the plugin performs. Every supported
 * platform implements all of it, with identical argument and result shapes;
 * failures are reported in-band (ok: false) where the operation has a result
 * type for it, and by rejection where it returns a plain list.
 */
export type PlatformBackend = {
	readonly platform: string;
	readonly features: PlatformFeatures;

	/** Launches or focuses the configured app, then positions its window. */
	launch(config: LaunchConfig): Promise<LaunchResult>;

	/** Reads the current rectangle of the configured app's window. */
	capture(config: LaunchConfig): Promise<CaptureResult>;

	/** Closes (or force-quits) the configured app's windows. */
	close(config: CloseConfig): Promise<CloseResult>;

	/** Apps that currently own a visible window, one entry per app. */
	listRunningApps(): Promise<RunningApp[]>;

	/** User-facing installed applications, sorted by name. */
	listInstalledApps(): Promise<InstalledApp[]>;

	/** Connected displays with bounds and work areas. */
	listMonitors(): Promise<MonitorEntry[]>;
};
