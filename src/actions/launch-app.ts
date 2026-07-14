import streamDeck, {
	action,
	DidReceiveSettingsEvent,
	KeyDownEvent,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import {
	buildCaptureScript,
	buildLaunchScript,
	buildMonitorListScript,
	runPowerShell,
	type CaptureResult,
	type LaunchResult,
	type MonitorEntry,
} from "../powershell";
import { toConfig, type LaunchSettings } from "../settings";
import { applyAutoTitle, sendInstalledApps, sendRunningApps } from "./pickers";

const logger = streamDeck.logger.createScope("LaunchApp");

/** Minimal surface needed by setStatus — satisfied by both key and dial actions. */
type SettingsHolder = {
	getSettings(): Promise<LaunchSettings>;
	setSettings(settings: LaunchSettings): Promise<void>;
};

@action({ UUID: "com.bowerstudio.snap-launcher.launch" })
export class LaunchApp extends SingletonAction<LaunchSettings> {
	/**
	 * Seed defaults once so the Property Inspector checkboxes reflect the
	 * behavior the plugin will actually use.
	 */
	override async onWillAppear(ev: WillAppearEvent<LaunchSettings>): Promise<void> {
		const settings = ev.payload.settings;

		const seeded: LaunchSettings = { ...settings };
		let changed = false;
		if (seeded.focusIfRunning === undefined) {
			seeded.focusIfRunning = true;
			changed = true;
		}
		if (seeded.waitSeconds === undefined) {
			seeded.waitSeconds = 10;
			changed = true;
		}
		if (seeded.positionMode === undefined) {
			// Migrate legacy keys from applyPosition; new keys default to zone.
			seeded.positionMode = (seeded.applyPosition ?? true) ? "zone" : "none";
			changed = true;
		}
		if (seeded.appSource === undefined) {
			seeded.appSource = "installed";
			changed = true;
		}
		if (changed) {
			await ev.action.setSettings(seeded);
		}

		// Plugin-set titles don't survive Stream Deck restarts; re-apply ours.
		// Stream Deck ignores this whenever the user has typed a custom Title.
		if (ev.action.isKey() && settings.autoTitle) {
			await ev.action.setTitle(settings.autoTitle);
		}
	}

	/** Auto-title the key with the app's name when a different app is picked. */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LaunchSettings>): Promise<void> {
		await applyAutoTitle(ev);
	}

	/** Launch or focus the app, then move its window to the saved rectangle. */
	override async onKeyDown(ev: KeyDownEvent<LaunchSettings>): Promise<void> {
		const settings = ev.payload.settings;
		if (!settings.appPath) {
			await ev.action.showAlert();
			await this.setStatus(ev.action, "No application selected — open the key settings and pick one.");
			return;
		}

		try {
			const config = toConfig(settings);
			const result = await runPowerShell<LaunchResult>(buildLaunchScript(config), config.waitSeconds * 1000 + 20_000);

			if (result.ok) {
				logger.debug(`ok launched=${result.launched} positioned=${result.positioned} movedDesktop=${result.movedDesktop} pid=${result.pid}`);
				await ev.action.showOk();
			} else {
				logger.error(`Launch failed: ${result.error}`);
				await ev.action.showAlert();
				await this.setStatus(ev.action, `Launch failed: ${result.error}`);
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			logger.error(`Launch error: ${message}`);
			await ev.action.showAlert();
			await this.setStatus(ev.action, `Launch error: ${message}`);
		}
	}

	/** Routes messages from the Property Inspector. */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, LaunchSettings>): Promise<void> {
		const payload = ev.payload;
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
			return;
		}
		const event = (payload as Record<string, JsonValue>)["event"];

		if (event === "getRunningApps") {
			await sendRunningApps();
		} else if (event === "getInstalledApps") {
			await sendInstalledApps();
		} else if (event === "getMonitors") {
			await this.sendMonitors();
		} else if (event === "captureWindow") {
			await this.captureWindow(ev);
		}
	}

	/** Populates the "Monitor" dropdown (sdpi-select datasource). */
	private async sendMonitors(): Promise<void> {
		const items: { label: string; value: string }[] = [{ label: "Primary monitor", value: "primary" }];

		try {
			const monitors = await runPowerShell<MonitorEntry[]>(buildMonitorListScript(), 20_000);
			if (Array.isArray(monitors)) {
				const sorted = [...monitors].sort((a, b) => a.deviceName.localeCompare(b.deviceName, undefined, { numeric: true }));
				for (const m of sorted) {
					const n = /(\d+)$/.exec(m.deviceName)?.[1];
					items.push({
						label: `Monitor ${n ?? m.deviceName} — ${m.width}×${m.height}${m.isPrimary ? " (primary)" : ""}`,
						value: m.deviceName,
					});
				}
			}
		} catch (e) {
			logger.error(`Failed to list monitors: ${e instanceof Error ? e.message : String(e)}`);
		}

		await streamDeck.ui.sendToPropertyInspector({ event: "getMonitors", items });
	}

	/** Captures the current window rect of the configured app into settings. */
	private async captureWindow(ev: SendToPluginEvent<JsonValue, LaunchSettings>): Promise<void> {
		const key = ev.action.isKey() ? ev.action : undefined;
		const settings = await ev.action.getSettings();

		if (!settings.appPath) {
			await key?.showAlert();
			await this.setStatus(ev.action, "Pick an application first, then capture.");
			return;
		}

		try {
			const result = await runPowerShell<CaptureResult>(buildCaptureScript(toConfig(settings)), 20_000);

			if (result.ok) {
				const status =
					`Saved ${result.width}×${result.height} at (${result.x}, ${result.y})` +
					(result.maximized ? " — window was maximized" : "");
				await ev.action.setSettings({
					...settings,
					x: result.x,
					y: result.y,
					width: result.width,
					height: result.height,
					captureStatus: status,
				});
				await key?.showOk();
			} else {
				await this.setStatus(ev.action, result.error);
				await key?.showAlert();
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			logger.error(`Capture failed: ${message}`);
			await this.setStatus(ev.action, `Capture failed: ${message}`);
			await key?.showAlert();
		}
	}

	/** Writes a status line into settings; the PI shows it via a bound field. */
	private async setStatus(holder: SettingsHolder, message: string): Promise<void> {
		try {
			const settings = await holder.getSettings();
			await holder.setSettings({ ...settings, captureStatus: message });
		} catch (e) {
			logger.warn(`Could not persist status: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
