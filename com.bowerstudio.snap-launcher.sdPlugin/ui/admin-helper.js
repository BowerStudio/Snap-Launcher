/**
 * The "Apps running as administrator" section of the Launch & Position PI:
 * shows whether the administrator helper is set up, and sets it up or removes
 * it on request. The plugin does the work; this only relays clicks and renders
 * the status it sends back.
 */

/**
 * Which controls a status leaves visible. Exported for tests.
 *
 * While the consent prompt is up, both buttons are hidden so a second click
 * can't stack another prompt behind it. Remove is only offered once there is
 * something to remove.
 */
export function controlsFor(status) {
	const busy = !!(status && status.busy);
	const installed = !!(status && status.installed);
	return {
		message: (status && status.message) || "Checking…",
		setupHidden: busy,
		setupLabel: installed ? "Set up again (repair / update)" : "Set up helper…",
		removeHidden: busy || !installed,
	};
}

function render(status) {
	const view = controlsFor(status);
	const messageEl = document.getElementById("admin-helper-status");
	const setupItem = document.getElementById("admin-helper-setup-item");
	const setupButton = document.getElementById("admin-helper-setup");
	const removeItem = document.getElementById("admin-helper-remove-item");
	if (messageEl) messageEl.textContent = view.message;
	if (setupItem) setupItem.hidden = view.setupHidden;
	if (setupButton) setupButton.textContent = view.setupLabel;
	if (removeItem) removeItem.hidden = view.removeHidden;
}

export function init() {
	const client = typeof window !== "undefined" && window.SDPIComponents && window.SDPIComponents.streamDeckClient;
	if (!client) return;

	const send = (event) => client.send("sendToPlugin", { event });
	const setup = document.getElementById("admin-helper-setup");
	const remove = document.getElementById("admin-helper-remove");
	if (setup) setup.addEventListener("click", () => send("installAdminHelper"));
	if (remove) remove.addEventListener("click", () => send("removeAdminHelper"));

	client.sendToPropertyInspector.subscribe((ev) => {
		const payload = ev && ev.payload;
		if (!payload || payload.event !== "adminHelper") return;
		render(payload);
	});

	render(null);
	send("getAdminHelper");
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
}
