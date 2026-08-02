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

/** Where a running app lives on disk: its bundle, or its bare executable. */
function runningAppPath(app) {
    var bundleUrl = app.bundleURL;
    if (bundleUrl && !bundleUrl.isNil()) return ObjC.unwrap(bundleUrl.path);
    var exeUrl = app.executableURL;
    if (exeUrl && !exeUrl.isNil()) return ObjC.unwrap(exeUrl.path);
    return null;
}

/**
 * Running processes belonging to a Steam game.
 *
 * A game's bundle identifier is whatever its developer chose and is not
 * recorded anywhere Snap Launcher can read, so the game is recognized by its
 * files instead: everything Steam installed for it — the game, its launcher,
 * its anti-cheat front-end — lives under one install directory.
 *
 * With no install directory (the game isn't installed) nothing can be matched
 * by path, and only an explicit Process name override can identify it; without
 * even that, matching nothing is the correct answer rather than a guess.
 */
function steamRunningApps(processNameOverride) {
    var root = STEAM.installDir;
    if (!root && !processNameOverride) return [];
    var prefix = root && root.charAt(root.length - 1) !== '/' ? root + '/' : root;

    var matches = [];
    var running = WORKSPACE.runningApplications;
    var count = Number(running.count);
    for (var i = 0; i < count; i++) {
        var app = running.objectAtIndex(i);
        if (root) {
            // Anything under the install directory — or the directory itself,
            // for a game whose install folder is the .app bundle.
            var appPath = runningAppPath(app);
            if (!appPath || (appPath !== root && appPath.indexOf(prefix) !== 0)) continue;
        } else if (Number(app.activationPolicy) !== 0) {
            // Override-only matching: narrowed by name further down, so keep
            // this to apps that can own a window at all.
            continue;
        }
        matches.push(app);
    }
    return matches;
}

/** Running apps matching a stored identity, newest activation order first. */
function runningAppsFor(identity, bundlePath, processNameOverride) {
    if (STEAM) return steamRunningApps(processNameOverride);

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
            // ObjC.unwrap on an NSArray is shallow: the elements are still
            // NSString refs, and String() on one of those yields the useless
            // "[id NSTaggedPointerString]" rather than the file name. Each
            // element has to be unwrapped in its own right.
            return ObjC.unwrap(contents).map(function (e) { return ObjC.unwrap(e); });
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
 * Lists the running applications a user could put on a key, one entry per app.
 *
 * Activation policy filters out agents and menu-bar-only processes, which have
 * no windows to launch or position. What remains is every app with a Dock icon,
 * which needs no permission at all to enumerate.
 *
 * Titles are decoration on top of that, and are read from the window server
 * rather than the Accessibility API. They require Screen Recording permission;
 * without it the list is still complete, with each app listed under its own
 * name. That trade is deliberate: a permission prompt must never stand between
 * the user and a populated dropdown.
 */
export function buildRunningListScript(): string {
	return wrapScript(`
        /**
         * Window titles by owning pid, best effort.
         *
         * CGWindowListCopyWindowInfo returns a CFArrayRef, and JXA has no
         * bridging metadata for a CF return type, so it hands back an opaque
         * Ref: it has no isNil, and ObjC.unwrap does nothing with it. Casting
         * it to its toll-free-bridged NSArray is what makes it readable.
         *
         * kCGWindowName is only populated when the host holds Screen Recording
         * permission. Without it every title is simply absent, which is why
         * this whole step is advisory — an app with no readable title still
         * gets listed below, under its own name.
         */
        var titlesByPid = {};
        try {
            // kCGWindowListOptionOnScreenOnly (1) | kCGWindowListExcludeDesktopElements (16)
            var infoRef = $.CGWindowListCopyWindowInfo(1 | 16, 0);
            var infoList = infoRef ? ObjC.castRefToObject(infoRef) : null;
            var windows = infoList && !infoList.isNil() ? ObjC.deepUnwrap(infoList) : null;
            if (windows && windows.length) {
                for (var w = 0; w < windows.length; w++) {
                    var win = windows[w];
                    var pid = win.kCGWindowOwnerPID;
                    if (pid === undefined || pid === null) continue;
                    // Layer 0 is the normal window layer; panels and menus sit above it.
                    if (Number(win.kCGWindowLayer) !== 0) continue;
                    var title = win.kCGWindowName ? String(win.kCGWindowName) : '';
                    if (!title.length) continue;
                    if (!titlesByPid[pid]) titlesByPid[pid] = title;
                }
            }
        } catch (e) {
            // Titles are a nicety; the app list itself must still be returned.
        }

        var items = [];
        var running = WORKSPACE.runningApplications;
        // Bridged counts arrive as strings; converted once rather than relying
        // on the comparison to coerce.
        var runningCount = Number(running.count);
        for (var i = 0; i < runningCount; i++) {
            var app = running.objectAtIndex(i);
            // NSApplicationActivationPolicyRegular === 0: has a Dock icon and
            // can own windows. Accessory (1) and prohibited (2) cannot.
            //
            // Number() is load-bearing: JXA bridges this enum property as a
            // string, so a strict !== 0 is true for every app alive and the
            // list comes back empty.
            if (Number(app.activationPolicy) !== 0) continue;

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
