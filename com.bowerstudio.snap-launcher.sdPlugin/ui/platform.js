/**
 * Adapts the Property Inspector to the OS the plugin is running on.
 *
 * The PI is a web page, so it cannot infer the host from its own environment —
 * the authority is the platform Stream Deck reports in the connection payload.
 *
 * Platform-conditional blocks ship with the `hidden` attribute already set in
 * the markup, so the browser never paints a control that is about to be taken
 * away. This module only ever *reveals* them, once the platform is known. If
 * the platform never arrives, everything platform-specific stays hidden and
 * the user is left with the controls that work everywhere.
 */

let platform = null;

/** "windows" | "mac" | null when it could not be determined. */
export function getPlatform() {
	return platform;
}

/**
 * Digs the platform out of a registration payload. getConnectionInfo() is
 * documented to carry the operating system, but not which shape it arrives in,
 * so both the wrapped ({ info: { application } }) and bare ({ application })
 * forms are accepted rather than betting on one.
 *
 * Exported for tests.
 */
export function platformFromConnection(connection) {
	const candidates = [
		connection && connection.info && connection.info.application,
		connection && connection.application,
	];
	for (const application of candidates) {
		const reported = application && application.platform;
		if (reported === "mac" || reported === "windows") {
			return reported;
		}
	}
	return null;
}

async function detectPlatform() {
	try {
		const client = globalThis.SDPIComponents && globalThis.SDPIComponents.streamDeckClient;
		if (!client || typeof client.getConnectionInfo !== "function") {
			return null;
		}
		return platformFromConnection(await client.getConnectionInfo());
	} catch {
		return null;
	}
}

/**
 * Reveals the blocks belonging to this platform and sets any file filters.
 * Exported for tests.
 */
export function applyPlatform(host, doc = document) {
	if (host === "windows" || host === "mac") {
		const revealClass = host === "mac" ? ".mac-only" : ".win-only";
		doc.querySelectorAll(revealClass).forEach((el) => {
			el.hidden = false;
		});
	}

	// A file picker offers the application file types of the host platform. With
	// no platform, it stays unfiltered rather than offering the wrong ones.
	doc.querySelectorAll("[data-accept-windows]").forEach((el) => {
		const accept =
			host === "mac"
				? el.getAttribute("data-accept-mac")
				: host === "windows"
					? el.getAttribute("data-accept-windows")
					: null;
		if (accept) {
			el.setAttribute("accept", accept);
		} else {
			el.removeAttribute("accept");
		}
	});
}

export async function initPlatform() {
	platform = await detectPlatform();
	applyPlatform(platform);
	return platform;
}

// Browser only; importing this module in a test must not touch the DOM.
if (typeof document !== "undefined") {
	initPlatform();
}
