import { wrapScript } from "./scripts";

/**
 * App identity on macOS.
 *
 * A key stores one opaque string in appPath, exactly as on Windows. Here that
 * is preferably `bundle:<id>` — a bundle identifier survives the app being
 * updated, renamed, or moved between /Applications and ~/Applications, which a
 * path does not. Apps with no readable bundle id fall back to the bundle path.
 */
const BUNDLE_PREFIX = "bundle:";

/** Builds the stored identity for an app, preferring its bundle id. */
export function appIdentity(bundlePath: string, bundleId: string | null | undefined): string {
	const id = (bundleId ?? "").trim();
	return id ? `${BUNDLE_PREFIX}${id}` : bundlePath;
}

/** Splits a stored identity back into whichever half it carries. */
export function parseIdentity(identity: string): { bundleId: string | null; bundlePath: string | null } {
	const value = (identity ?? "").trim();
	if (value.startsWith(BUNDLE_PREFIX)) {
		const id = value.slice(BUNDLE_PREFIX.length);
		return { bundleId: id.length > 0 ? id : null, bundlePath: null };
	}
	return { bundleId: null, bundlePath: value.length > 0 ? value : null };
}

/** Display name for a bundle path: "/Applications/Slack.app" -> "Slack". */
export function bundleDisplayName(bundlePath: string): string {
	const base = bundlePath.split("/").pop() ?? "";
	return base.replace(/\.app$/i, "");
}

/**
 * Shared JXA helpers for resolving an identity to a bundle path or a running
 * application. Included by the app-discovery and window-control scripts alike.
 */
export const APP_HELPERS = `
var BUNDLE_PREFIX = ${JSON.stringify(BUNDLE_PREFIX)};

function parseIdentity(identity) {
    var value = (identity || '').trim();
    if (value.indexOf(BUNDLE_PREFIX) === 0) {
        var id = value.slice(BUNDLE_PREFIX.length);
        return { bundleId: id.length ? id : null, bundlePath: null };
    }
    return { bundleId: null, bundlePath: value.length ? value : null };
}

var WORKSPACE = $.NSWorkspace.sharedWorkspace;

function bundleIdForPath(path) {
    var bundle = $.NSBundle.bundleWithPath(path);
    if (!bundle || bundle.isNil()) return null;
    var id = bundle.bundleIdentifier;
    return id && !id.isNil() ? ObjC.unwrap(id) : null;
}

/**
 * Turns a stored identity into a bundle path. A bundle id is resolved through
 * LaunchServices, so the app is found wherever it now lives; a stored path is
 * used only when it still exists.
 */
function resolveBundlePath(identity) {
    var parsed = parseIdentity(identity);
    if (parsed.bundleId) {
        var url = WORKSPACE.URLForApplicationWithBundleIdentifier(parsed.bundleId);
        if (url && !url.isNil()) return ObjC.unwrap(url.path);
    }
    if (parsed.bundlePath) {
        if ($.NSFileManager.defaultManager.fileExistsAtPath(parsed.bundlePath)) return parsed.bundlePath;
        // A path that no longer resolves may still name an installed app.
        var id = bundleIdForPath(parsed.bundlePath);
        if (id) {
            var byId = WORKSPACE.URLForApplicationWithBundleIdentifier(id);
            if (byId && !byId.isNil()) return ObjC.unwrap(byId.path);
        }
    }
    return null;
}

/** Running apps matching a stored identity, newest activation order first. */
function runningAppsFor(identity, bundlePath) {
    var parsed = parseIdentity(identity);
    var bundleId = parsed.bundleId;
    if (!bundleId && bundlePath) bundleId = bundleIdForPath(bundlePath);

    var matches = [];
    var running = WORKSPACE.runningApplications;
    for (var i = 0; i < running.count; i++) {
        var app = running.objectAtIndex(i);
        var appId = app.bundleIdentifier;
        var appIdStr = appId && !appId.isNil() ? ObjC.unwrap(appId) : null;
        var appUrl = app.bundleURL;
        var appPath = appUrl && !appUrl.isNil() ? ObjC.unwrap(appUrl.path) : null;

        if ((bundleId && appIdStr === bundleId) || (bundlePath && appPath === bundlePath)) {
            matches.push(app);
        }
    }
    return matches;
}
`;

/**
 * Lists installed applications for the "Installed apps" dropdown.
 *
 * Searched locations mirror where macOS actually puts user-facing apps, plus
 * one level of category folders (Utilities, and the folders installers like
 * Adobe's create). Deduplicated by bundle id so an app present in more than one
 * location appears once, and sorted by name.
 *
 * Requires no permission: this is filesystem enumeration, nothing more.
 */
export function buildInstalledListScript(): string {
	return wrapScript(`
        var fm = $.NSFileManager.defaultManager;
        var home = ObjC.unwrap($.NSHomeDirectory());
        var roots = ['/Applications', '/System/Applications', home + '/Applications'];

        var items = [];
        var seen = {};

        function addBundle(path) {
            if (!/\\.app$/i.test(path)) return;
            var name = path.split('/').pop().replace(/\\.app$/i, '');
            var id = bundleIdForPath(path);
            // Dedupe on identity, so the same app in two roots appears once.
            var key = (id || path).toLowerCase();
            if (seen[key]) return;
            seen[key] = true;
            items.push({ name: name, path: id ? (BUNDLE_PREFIX + id) : path });
        }

        function entries(dir) {
            var contents = fm.contentsOfDirectoryAtPathError(dir, $());
            if (!contents || contents.isNil()) return [];
            return ObjC.unwrap(contents).map(function (e) { return String(e); });
        }

        for (var r = 0; r < roots.length; r++) {
            var root = roots[r];
            var names = entries(root);
            for (var i = 0; i < names.length; i++) {
                var full = root + '/' + names[i];
                if (/\\.app$/i.test(full)) {
                    addBundle(full);
                } else {
                    // One level down only: category folders like Utilities.
                    var nested = entries(full);
                    for (var j = 0; j < nested.length; j++) {
                        var nestedPath = full + '/' + nested[j];
                        if (/\\.app$/i.test(nestedPath)) addBundle(nestedPath);
                    }
                }
            }
        }

        items.sort(function (a, b) { return a.name.localeCompare(b.name); });
        return items;
`, APP_HELPERS);
}

/**
 * Lists applications that currently own a visible window, one entry per app.
 *
 * Activation policy filters out agents and menu-bar-only processes, which have
 * no windows to launch or position. Window titles come from the window server
 * rather than the Accessibility API, so this works before the user has granted
 * Accessibility — an app whose title cannot be read still appears, listed under
 * its own name.
 */
export function buildRunningListScript(): string {
	return wrapScript(`
        // kCGWindowListOptionOnScreenOnly (1) | kCGWindowListExcludeDesktopElements (16)
        var infoList = $.CGWindowListCopyWindowInfo(1 | 16, 0);
        var titlesByPid = {};
        if (infoList && !infoList.isNil()) {
            var windows = ObjC.unwrap(infoList);
            for (var w = 0; w < windows.length; w++) {
                var win = windows[w];
                var pid = win.kCGWindowOwnerPID;
                if (pid === undefined || pid === null) continue;
                // Layer 0 is the normal window layer; panels and menus sit above it.
                if (win.kCGWindowLayer !== 0) continue;
                var title = win.kCGWindowName ? String(win.kCGWindowName) : '';
                if (!title.length) continue;
                if (!titlesByPid[pid]) titlesByPid[pid] = title;
            }
        }

        var items = [];
        var running = WORKSPACE.runningApplications;
        for (var i = 0; i < running.count; i++) {
            var app = running.objectAtIndex(i);
            // NSApplicationActivationPolicyRegular === 0: has a Dock icon and
            // can own windows. Accessory (1) and prohibited (2) cannot.
            if (app.activationPolicy !== 0) continue;

            var url = app.bundleURL;
            var path = url && !url.isNil() ? ObjC.unwrap(url.path) : null;
            if (!path) continue;

            var idObj = app.bundleIdentifier;
            var bundleId = idObj && !idObj.isNil() ? ObjC.unwrap(idObj) : null;
            var nameObj = app.localizedName;
            var display = nameObj && !nameObj.isNil() ? ObjC.unwrap(nameObj) : path.split('/').pop().replace(/\\.app$/i, '');
            var pidKey = String(app.processIdentifier);

            items.push({
                name: display,
                title: titlesByPid[pidKey] || display,
                path: bundleId ? (BUNDLE_PREFIX + bundleId) : path,
                display: display
            });
        }

        items.sort(function (a, b) { return a.title.localeCompare(b.title); });
        return items;
`, APP_HELPERS);
}
