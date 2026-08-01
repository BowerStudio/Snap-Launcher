import type { PlatformBackend } from "../backend";
import type {
	CaptureResult,
	CloseConfig,
	CloseResult,
	InstalledApp,
	LaunchConfig,
	LaunchResult,
	MonitorEntry,
	RunningApp,
} from "../types";
import {
	buildCaptureScript,
	buildCloseScript,
	buildInstalledListScript,
	buildLaunchScript,
	buildListScript,
	buildMonitorListScript,
	runPowerShell,
} from "./powershell";

/** Headroom over an operation's own waiting, for interpreter startup and interop. */
const OVERHEAD_MS = 20_000;

/** The monitor script predates MonitorEntry.index and does not emit it. */
type RawMonitor = Omit<MonitorEntry, "index">;

/**
 * Derives the 1-based arrangement position from a Windows device name
 * ("\\.\DISPLAY2" -> 2). deviceName itself is left byte-identical: it is
 * persisted as a key's monitorId, so rewriting it would orphan saved settings.
 * Device names without a trailing number keep their enumeration order.
 */
function displayIndex(deviceName: string, fallback: number): number {
	const n = /(\d+)$/.exec(deviceName)?.[1];
	return n ? Number(n) : fallback;
}

/**
 * Windows backend: every operation is one PowerShell process emitting a single
 * JSON line. Behavior is exactly what the plugin did before the platform
 * abstraction existed — only the timeout arithmetic moved here from the actions.
 */
export const windowsBackend: PlatformBackend = {
	platform: "win32",
	features: { virtualDesktop: true },

	launch(config: LaunchConfig): Promise<LaunchResult> {
		return runPowerShell<LaunchResult>(buildLaunchScript(config), config.waitSeconds * 1000 + OVERHEAD_MS);
	},

	capture(config: LaunchConfig): Promise<CaptureResult> {
		return runPowerShell<CaptureResult>(buildCaptureScript(config), OVERHEAD_MS);
	},

	close(config: CloseConfig): Promise<CloseResult> {
		// closeThenKill spends up to waitSeconds waiting before force-quitting.
		const grace = config.closeMode === "closeThenKill" ? config.waitSeconds * 1000 : 0;
		return runPowerShell<CloseResult>(buildCloseScript(config), grace + OVERHEAD_MS);
	},

	listRunningApps(): Promise<RunningApp[]> {
		return runPowerShell<RunningApp[]>(buildListScript(), OVERHEAD_MS);
	},

	listInstalledApps(): Promise<InstalledApp[]> {
		// Walking both Start Menu trees is slower than the other operations.
		return runPowerShell<InstalledApp[]>(buildInstalledListScript(), 30_000);
	},

	async listMonitors(): Promise<MonitorEntry[]> {
		const raw = await runPowerShell<RawMonitor[]>(buildMonitorListScript(), OVERHEAD_MS);
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw.map((m, i) => ({ ...m, index: displayIndex(m.deviceName, i + 1) }));
	},
};
