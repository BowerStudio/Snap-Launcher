import streamDeck from "@elgato/streamdeck";
import type { DidReceiveSettingsEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { getBackend, type InstalledApp, type RunningApp } from "../platform";

const logger = streamDeck.logger.createScope("Pickers");

/**
 * Friendly names of the apps offered in the last Running/Installed-apps scan,
 * by value. Shared by every action so a key auto-titles correctly no matter
 * which action's Property Inspector performed the scan.
 */
export const appNames = new Map<string, string>();

/** Populates a "Running apps" dropdown (sdpi-select datasource). */
export async function sendRunningApps(): Promise<void> {
	let items: { label: string; value: string }[] = [];

	try {
		const apps = await getBackend().listRunningApps();
		if (Array.isArray(apps)) {
			const seen = new Set<string>();
			items = apps
				.filter((a): a is RunningApp & { path: string } => typeof a.path === "string" && a.path.length > 0)
				.filter((a) => {
					const key = a.path.toLowerCase();
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				})
				.sort((a, b) => a.title.localeCompare(b.title))
				.map((a) => {
					const display = (a.display ?? "").trim() || a.name;
					appNames.set(a.path, display);
					// Skip the app-name suffix when the window title already contains it.
					const label = a.title.toLowerCase().includes(display.toLowerCase())
						? truncate(a.title, 40)
						: `${truncate(a.title, 40)} - ${display}`;
					return { label, value: a.path };
				});
		}
	} catch (e) {
		logger.error(`Failed to list running apps: ${e instanceof Error ? e.message : String(e)}`);
	}

	await streamDeck.ui.sendToPropertyInspector({ event: "getRunningApps", items });
}

/** Populates an "Installed apps" dropdown (sdpi-select datasource). */
export async function sendInstalledApps(): Promise<void> {
	await sendAppList("getInstalledApps", () => getBackend().listInstalledApps(), "installed apps");
}

/** Populates a "Steam games" dropdown (sdpi-select datasource). */
export async function sendSteamGames(): Promise<void> {
	await sendAppList("getSteamGames", () => getBackend().listSteamGames(), "Steam games");
}

/**
 * Sends one name/value list to the Property Inspector. A scan that fails sends
 * an empty list rather than nothing at all, so the dropdown settles on its
 * placeholder instead of spinning on "Loading…" forever.
 */
async function sendAppList(event: string, scan: () => Promise<InstalledApp[]>, what: string): Promise<void> {
	let items: { label: string; value: string }[] = [];

	try {
		const apps = await scan();
		if (Array.isArray(apps)) {
			items = apps
				.filter(
					(a) =>
						typeof a.path === "string" &&
						a.path.length > 0 &&
						typeof a.name === "string" &&
						a.name.length > 0,
				)
				.map((a) => {
					appNames.set(a.path, a.name);
					return { label: truncate(a.name, 50), value: a.path };
				});
		}
	} catch (e) {
		logger.error(`Failed to list ${what}: ${e instanceof Error ? e.message : String(e)}`);
	}

	await streamDeck.ui.sendToPropertyInspector({ event, items });
}

type TitledSettings = JsonObject & { appPath?: string; titledFor?: string; autoTitle?: string };

/**
 * Auto-title the key with the app's name when a different app is picked.
 * setTitle only shows while the user's own Title field is empty, so a
 * manually entered title always wins.
 */
export async function applyAutoTitle<T extends TitledSettings>(ev: DidReceiveSettingsEvent<T>): Promise<void> {
	const settings = ev.payload.settings;
	const appPath = (settings.appPath ?? "").trim();
	if (!appPath || appPath === settings.titledFor) {
		return;
	}

	const name = appNames.get(appPath) ?? friendlyName(appPath);
	if (!name) {
		return;
	}

	if (ev.action.isKey()) {
		await ev.action.setTitle(name);
	}
	await ev.action.setSettings({ ...settings, titledFor: appPath, autoTitle: name });
}

type IconedSettings = JsonObject & { appPath?: string; iconFor?: string; autoImage?: string; iconStatus?: string };

/** The action a key's icon is applied to. Both events carry the same union. */
type IconAction<T extends IconedSettings> = DidReceiveSettingsEvent<T>["action"];

/**
 * Icon lookups currently running, by action instance and app.
 *
 * A Property Inspector writes settings on every keystroke, and a lookup that
 * walks an install folder takes a moment; without this, typing in any field
 * while one is in flight would start another for the same app.
 */
const iconLookups = new Set<string>();

/**
 * Tail of the lookup queue.
 *
 * Every key appears at once when Stream Deck starts, and each one that has
 * never had an icon looked up wants one. Run concurrently that would be a
 * subprocess per key at the worst possible moment, so they take their turn.
 */
let iconQueue: Promise<unknown> = Promise.resolve();

function queued<T>(work: () => Promise<T>): Promise<T> {
	const next = iconQueue.then(work, work);
	// The queue must survive a failed lookup, so it tracks completion, not success.
	iconQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

/**
 * Sets the key's image to the app's own icon whenever a different app becomes
 * the key's app — picked in the Property Inspector, or already configured on a
 * key that predates this ever being looked up.
 *
 * This mirrors applyAutoTitle in every respect that matters: Stream Deck
 * ignores setImage whenever the user has chosen an image of their own, and the
 * result is written back to settings so willAppear can re-apply it after a
 * restart without touching the disk again.
 *
 * Every outcome — an icon, no icon, or a failed lookup — records iconFor. A
 * lookup costs a subprocess, so it must happen once per app chosen rather than
 * once per keystroke; re-picking the app is what asks for another try.
 *
 * Never rejects: a key that cannot show its app's icon still works perfectly
 * well, and callers that fire this off during willAppear must not have to guard
 * against it.
 */
export async function applyAutoIcon<T extends IconedSettings>(action: IconAction<T>, settings: T): Promise<void> {
	const appPath = (settings.appPath ?? "").trim();
	if (appPath === (settings.iconFor ?? "")) {
		return;
	}

	const lookup = `${action.id}:${appPath}`;
	if (iconLookups.has(lookup)) {
		return;
	}
	iconLookups.add(lookup);

	try {
		// Clearing the app puts the action's own image back on the key.
		if (!appPath) {
			await setImage(action, undefined);
			await patchSettings(action, { iconFor: "", autoImage: "", iconStatus: "" });
			return;
		}

		const result = await queued(() => getBackend().findAppIcon(appPath));
		if (result.found) {
			await setImage(action, result.icon.image);
			await patchSettings(action, {
				iconFor: appPath,
				autoImage: result.icon.image,
				iconStatus: `Set from ${result.icon.sourcePath || "the app's icon"}`,
			});
		} else {
			await setImage(action, undefined);
			await patchSettings(action, { iconFor: appPath, autoImage: "", iconStatus: result.reason });
		}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		logger.error(`Failed to find an icon for ${appPath}: ${message}`);
		await patchSettings(action, { iconFor: appPath, iconStatus: `Icon lookup failed: ${message}` });
	} finally {
		iconLookups.delete(lookup);
	}
}

/** Only keys carry an image; the manifest declares no other controller. */
async function setImage<T extends IconedSettings>(action: IconAction<T>, image: string | undefined): Promise<void> {
	if (action.isKey()) {
		await action.setImage(image);
	}
}

/**
 * Merges fields into the action's current settings.
 *
 * Read fresh rather than merged onto the settings this started with: a lookup
 * takes a moment, and anything the user typed in the meantime — or a title
 * applied alongside it — must not be rolled back by this write.
 */
async function patchSettings<T extends IconedSettings>(action: IconAction<T>, patch: IconedSettings): Promise<void> {
	try {
		const current = await action.getSettings();
		// The cast is the merge itself: every field written here is one of
		// IconedSettings' own optional strings, which T is required to carry.
		await action.setSettings({ ...current, ...patch } as T);
	} catch (e) {
		logger.warn(`Could not persist the key image: ${e instanceof Error ? e.message : String(e)}`);
	}
}

export function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/**
 * Fallback key title when the picked app wasn't in the last apps scan
 * (e.g. chosen via the file browser): the file name without its extension.
 *
 * Identity-style values carry no readable name and yield nothing: a Windows
 * Store AUMID, a macOS "bundle:com.tinyspeck.slackmacgap", and a "steam:1361210"
 * — the trailing component of a bundle id, or a Steam app id, is not a name
 * anyone would recognise on a key.
 */
export function friendlyName(appPath: string): string {
	const lower = appPath.toLowerCase();
	if (
		lower.startsWith("shell:appsfolder\\") ||
		appPath.includes("!") ||
		lower.startsWith("bundle:") ||
		lower.startsWith("steam:")
	) {
		return "";
	}
	const base = appPath.split(/[\\/]/).pop() ?? "";
	return base.replace(/\.(exe|lnk|bat|cmd|app)$/i, "");
}
