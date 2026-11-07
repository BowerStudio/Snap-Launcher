/**
 * The icon picker of the Launch & Position PI: shows every icon the plugin can
 * find for the key's app, and lets the user choose which one the key shows.
 *
 * The plugin does the finding and the applying; this only asks for the list,
 * renders it, and relays a click. Which tile is selected comes from the key's
 * settings (iconChoice), so the picker always agrees with what the key shows.
 */

/** The value that stands for "let the plugin choose". */
export const AUTOMATIC = "";

/** The file name of a path, in either slash style. */
export function fileName(path) {
	const parts = String(path || "").split(/[\\/]/);
	return parts[parts.length - 1] || "";
}

/**
 * What the picker should show, from the plugin's last reply and the key's
 * settings. Exported for tests.
 *
 * A reply for an app other than the key's current one is stale — the user
 * picked a different app while the scan ran — and is shown as nothing at all
 * rather than as another app's icons.
 */
export function pickerView(reply, settings) {
	const s = settings || {};
	const appPath = String(s.appPath || "").trim();
	if (!reply || reply.appPath !== appPath) {
		return { message: "", tiles: [] };
	}
	if (reply.loading) {
		return { message: "Looking for icons…", tiles: [] };
	}

	const icons = Array.isArray(reply.icons) ? reply.icons.filter((i) => i && i.image && i.path) : [];
	if (icons.length === 0) {
		return { message: reply.reason || "No icons were found for this app.", tiles: [] };
	}

	const choice = String(s.iconChoice || AUTOMATIC);
	// A choice that is no longer on offer (the file was removed) leaves nothing
	// highlighted rather than pretending Automatic is in effect.
	const tiles = [
		{
			path: AUTOMATIC,
			image: "",
			label: "Auto",
			title: "Automatic — the best icon the plugin finds",
			selected: choice === AUTOMATIC,
		},
		...icons.map((i) => ({
			path: i.path,
			image: i.image,
			label: "",
			title: fileName(i.path) + (i.width ? " — " + i.width + "×" + i.height : "") + "\n" + i.path,
			selected: choice !== AUTOMATIC && choice === i.path,
		})),
	];
	return { message: "Choose the image this key shows.", tiles };
}

export function init() {
	const client = typeof window !== "undefined" && window.SDPIComponents && window.SDPIComponents.streamDeckClient;
	const panel = document.getElementById("icon-picker");
	const grid = document.getElementById("icon-picker-grid");
	const message = document.getElementById("icon-picker-message");
	const toggle = document.getElementById("icon-picker-toggle");
	if (!client || !panel || !grid || !message || !toggle) return;

	let settings = {};
	let reply = null;
	let open = false;

	function render() {
		panel.hidden = !open;
		toggle.textContent = open ? "Hide icons" : "Choose icon…";
		const view = pickerView(reply, settings);
		message.textContent = view.message;
		grid.replaceChildren(
			...view.tiles.map((tile) => {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "ip-tile" + (tile.selected ? " ip-selected" : "");
				button.title = tile.title;
				button.setAttribute("role", "option");
				button.setAttribute("aria-selected", tile.selected ? "true" : "false");
				button.dataset.path = tile.path;
				if (tile.image) {
					const img = document.createElement("img");
					img.src = tile.image;
					img.alt = tile.title;
					button.append(img);
				} else {
					button.textContent = tile.label;
				}
				return button;
			}),
		);
	}

	function request() {
		reply = { appPath: String(settings.appPath || "").trim(), loading: true };
		render();
		client.send("sendToPlugin", { event: "getAppIcons" });
	}

	toggle.addEventListener("click", () => {
		open = !open;
		if (open) request();
		else render();
	});

	grid.addEventListener("click", (e) => {
		const tile = e.target.closest("[data-path]");
		if (!tile) return;
		const path = tile.dataset.path || AUTOMATIC;
		// Shown at once; the settings the plugin writes back confirm it.
		settings = { ...settings, iconChoice: path };
		render();
		client.send("sendToPlugin", { event: "chooseAppIcon", path });
	});

	function adopt(next) {
		const previous = String(settings.appPath || "").trim();
		settings = next || {};
		// A different app has different icons: an open picker looks again.
		if (open && String(settings.appPath || "").trim() !== previous) request();
		else render();
	}

	client.getSettings().then((p) => adopt((p && p.settings) || {}));
	if (client.didReceiveSettings) {
		client.didReceiveSettings.subscribe((ev) => adopt((ev && ev.payload && ev.payload.settings) || {}));
	}
	client.sendToPropertyInspector.subscribe((ev) => {
		const payload = ev && ev.payload;
		if (!payload || payload.event !== "appIcons") return;
		reply = payload;
		render();
	});

	render();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
}
