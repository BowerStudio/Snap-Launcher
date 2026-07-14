import streamDeck, {
	action,
	DidReceiveSettingsEvent,
	KeyDownEvent,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { buildCloseScript, runPowerShell, type CloseResult } from "../powershell";
import { toCloseConfig, type CloseSettings } from "../settings";
import { applyAutoTitle, sendInstalledApps, sendRunningApps } from "./pickers";

const logger = streamDeck.logger.createScope("CloseApp");

/** Minimal surface needed by setStatus — satisfied by both key and dial actions. */
type SettingsHolder = {
	getSettings(): Promise<CloseSettings>;
	setSettings(settings: CloseSettings): Promise<void>;
};

@action({ UUID: "com.bowerstudio.snap-launcher.close" })
export class CloseApp extends SingletonAction<CloseSettings> {
	/**
	 * Seed defaults once so the Property Inspector reflects the behavior the
	 * plugin will actually use.
	 */
	override async onWillAppear(ev: WillAppearEvent<CloseSettings>): Promise<void> {
		const settings = ev.payload.settings;

		const seeded: CloseSettings = { ...settings };
		let changed = false;
		if (seeded.appSource === undefined) {
			seeded.appSource = "installed";
			changed = true;
		}
		if (seeded.closeMode === undefined) {
			seeded.closeMode = "close";
			changed = true;
		}
		if (seeded.waitSeconds === undefined) {
			seeded.waitSeconds = 5;
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
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CloseSettings>): Promise<void> {
		await applyAutoTitle(ev);
	}

	/** Close (or force-quit) the app's windows. Nothing running = success. */
	override async onKeyDown(ev: KeyDownEvent<CloseSettings>): Promise<void> {
		const settings = ev.payload.settings;
		if (!settings.appPath) {
			await ev.action.showAlert();
			await this.setStatus(ev.action, "No application selected — open the key settings and pick one.");
			return;
		}

		try {
			const config = toCloseConfig(settings);
			// closeThenKill spends up to waitSeconds waiting before force-quitting.
			const timeoutMs = (config.closeMode === "closeThenKill" ? config.waitSeconds * 1000 : 0) + 20_000;
			const result = await runPowerShell<CloseResult>(buildCloseScript(config), timeoutMs);

			if (result.ok) {
				logger.debug(`ok found=${result.found} closed=${result.closed} killed=${result.killed}`);
				const status =
					result.found === 0
						? "Nothing to close — the app wasn't running."
						: `Closed ${result.closed} window(s)` + (result.killed > 0 ? `, force-quit ${result.killed} process(es)` : "") + ".";
				await this.setStatus(ev.action, status);
				await ev.action.showOk();
			} else {
				logger.error(`Close failed: ${result.error}`);
				await ev.action.showAlert();
				await this.setStatus(ev.action, `Close failed: ${result.error}`);
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			logger.error(`Close error: ${message}`);
			await ev.action.showAlert();
			await this.setStatus(ev.action, `Close error: ${message}`);
		}
	}

	/** Routes messages from the Property Inspector. */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, CloseSettings>): Promise<void> {
		const payload = ev.payload;
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
			return;
		}
		const event = (payload as Record<string, JsonValue>)["event"];

		if (event === "getRunningApps") {
			await sendRunningApps();
		} else if (event === "getInstalledApps") {
			await sendInstalledApps();
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
