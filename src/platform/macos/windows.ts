import type { CloseConfig, LaunchConfig, SteamTarget } from "../types";
import { APP_HELPERS } from "./apps";
import { DISPLAY_HELPERS } from "./displays";
import { jsConfig, wrapScript } from "./scripts";

/**
 * Zone geometry, mirroring the Windows backend's Get-ZoneRect exactly.
 *
 * Right and bottom zones extend to the work-area edge rather than being sized
 * as half, so two halves tile a work area of odd width or height with no gap
 * and no overlap. Both implementations are asserted against the same fixture
 * table so they cannot drift apart.
 *
 * Exported so tests can evaluate it directly — it is pure arithmetic, so it
 * can be verified without a Mac.
 */
export const ZONE_HELPERS = `
function zoneRect(waLeft, waTop, waWidth, waHeight, zone) {
    var midX = waLeft + Math.floor(waWidth / 2);
    var midY = waTop + Math.floor(waHeight / 2);
    var right = waLeft + waWidth;
    var bottom = waTop + waHeight;
    switch (zone) {
        case 'left':        return { x: waLeft, y: waTop, width: midX - waLeft, height: waHeight };
        case 'right':       return { x: midX, y: waTop, width: right - midX, height: waHeight };
        case 'top':         return { x: waLeft, y: waTop, width: waWidth, height: midY - waTop };
        case 'bottom':      return { x: waLeft, y: midY, width: waWidth, height: bottom - midY };
        case 'topLeft':     return { x: waLeft, y: waTop, width: midX - waLeft, height: midY - waTop };
        case 'topRight':    return { x: midX, y: waTop, width: right - midX, height: midY - waTop };
        case 'bottomLeft':  return { x: waLeft, y: midY, width: midX - waLeft, height: bottom - midY };
        case 'bottomRight': return { x: midX, y: midY, width: right - midX, height: bottom - midY };
        default:            return { x: waLeft, y: waTop, width: waWidth, height: waHeight };
    }
}

/**
 * Picks the configured display, falling back to the primary (then the first)
 * when the saved one is no longer connected. The saved setting is never
 * rewritten, so reconnecting the display restores the original behavior.
 */
function resolveTargetMonitor(monitors, monitorId) {
    var i;
    if (monitorId && monitorId !== 'primary') {
        for (i = 0; i < monitors.length; i++) {
            if (monitors[i].deviceName === monitorId) return monitors[i];
        }
    }
    for (i = 0; i < monitors.length; i++) {
        if (monitors[i].isPrimary) return monitors[i];
    }
    return monitors.length ? monitors[0] : null;
}
`;

/**
 * Window discovery and manipulation through System Events.
 *
 * Everything here goes through System Events rather than the target
 * application: scripting an app directly would raise a per-application
 * "Stream Deck wants to control <app>" prompt for every app a user configures.
 *
 * Accessibility attributes are read and written defensively — apps are free to
 * refuse, and a refusal must never take down an otherwise successful press.
 */
const WINDOW_HELPERS = `
function attrValue(win, name) {
    try { return win.attributes.byName(name).value(); } catch (e) { return null; }
}

function setAttrValue(win, name, value) {
    try { win.attributes.byName(name).value = value; return true; } catch (e) { return false; }
}

function windowTitle(win) {
    try { return String(win.name() || ''); } catch (e) { return ''; }
}

/** Stands in for a window handle: System Events windows have no stable id. */
function windowKey(pid, win, index) {
    return pid + ':' + index + ':' + windowTitle(win);
}

function processForPid(pid) {
    var se = systemEvents();
    var matches = se.processes.whose({ unixId: pid })();
    return matches.length ? matches[0] : null;
}

/**
 * Every candidate window of the target app, in the order System Events reports
 * them, which is front-to-back within each process.
 */
function candidateWindows(identity, bundlePath, processNameOverride) {
    var result = [];
    var apps = runningAppsFor(identity, bundlePath, processNameOverride);

    for (var a = 0; a < apps.length; a++) {
        var pid = apps[a].processIdentifier;
        var proc = processForPid(pid);
        if (!proc) continue;

        if (processNameOverride) {
            var procName = '';
            try { procName = String(proc.name()); } catch (e) { procName = ''; }
            if (procName.toLowerCase() !== processNameOverride.toLowerCase()) continue;
        }

        var wins = [];
        try { wins = proc.windows(); } catch (e) { wins = []; }
        for (var w = 0; w < wins.length; w++) {
            result.push({
                pid: pid,
                app: apps[a],
                proc: proc,
                win: wins[w],
                key: windowKey(pid, wins[w], w),
                title: windowTitle(wins[w])
            });
        }
    }
    return result;
}

/** First candidate matching the title filter and not in the exclusion set. */
function findTargetWindow(identity, bundlePath, processNameOverride, titleFilter, excludeKeys) {
    var candidates = candidateWindows(identity, bundlePath, processNameOverride);
    var needle = (titleFilter || '').toLowerCase();

    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (needle && c.title.toLowerCase().indexOf(needle) === -1) continue;
        if (excludeKeys && excludeKeys.indexOf(c.key) !== -1) continue;
        return c;
    }
    return null;
}

/** Brings the window's application forward without scripting the app itself. */
function raise(candidate) {
    try { candidate.proc.frontmost = true; } catch (e) { /* best effort */ }
    try {
        // NSApplicationActivateIgnoringOtherApps
        candidate.app.activateWithOptions(2);
    } catch (e) { /* best effort */ }
}

/**
 * Moves and resizes a window, then re-reads it. An app that enforces a minimum
 * or fixed size simply keeps what it accepted: per spec that is a success, not
 * a failed key press.
 *
 * No invisible-border compensation is needed — unlike Win32's GetWindowRect,
 * the Accessibility frame is the visible frame.
 */
function applyRect(win, rect) {
    setAttrValue(win, 'AXMinimized', false);
    setAttrValue(win, 'AXFullScreen', false);

    try { win.position = [rect.x, rect.y]; } catch (e) { /* refused */ }
    try { win.size = [rect.width, rect.height]; } catch (e) { /* refused */ }
    // Re-apply the origin: resizing can shift a window that was clamped.
    try { win.position = [rect.x, rect.y]; } catch (e) { /* refused */ }

    return readFrame(win);
}

function readFrame(win) {
    var pos = null;
    var size = null;
    try { pos = win.position(); } catch (e) { pos = null; }
    try { size = win.size(); } catch (e) { size = null; }
    if (!pos || !size) return null;
    return { x: Math.round(pos[0]), y: Math.round(pos[1]), width: Math.round(size[0]), height: Math.round(size[1]) };
}

/** Resolves the rectangle a launch should apply, or null for "leave it alone". */
function targetRect(cfg) {
    if (cfg.positionMode === 'custom') {
        return { x: cfg.x, y: cfg.y, width: cfg.width, height: cfg.height };
    }
    if (cfg.positionMode !== 'zone') return null;

    var monitors = listDisplays();
    if (!monitors.length) fail('No displays could be found.');
    var mon = resolveTargetMonitor(monitors, cfg.monitorId);
    if (!mon) fail('No displays could be found.');
    return zoneRect(mon.workLeft, mon.workTop, mon.workWidth, mon.workHeight, cfg.zone);
}

/**
 * The bundle path for the configured app, or a failure naming the problem.
 *
 * A Steam game has no bundle path to resolve — it is identified by its install
 * directory instead, which is therefore what stands in for one. A game with no
 * files at all cannot be recognized however it is started, so that is reported
 * for what it is rather than left to surface as a mystifying timeout.
 */
function requireBundlePath(identity) {
    if (STEAM) {
        if (!STEAM.installDir && !CFG.processName) {
            fail('"' + STEAM.name + '" does not appear to be installed in any Steam library. Install it in Steam, or set a Process name override in the key settings.');
        }
        return STEAM.installDir;
    }

    var bundlePath = resolveBundlePath(identity);
    if (!bundlePath) {
        fail('Could not find the application for "' + identity + '". Re-pick the app in the key settings.');
    }
    return bundlePath;
}

/** What to call the target in a message: a game's name, or its bundle path. */
function targetDescription(bundlePath) {
    return STEAM ? STEAM.name : bundlePath;
}
`;

/** Everything the window-control scripts share, in dependency order. */
const HELPERS = `${APP_HELPERS}
${DISPLAY_HELPERS}
${ZONE_HELPERS}
${WINDOW_HELPERS}`;

/**
 * Launches (or focuses) the configured application, waits for its window, then
 * restores and repositions it.
 *
 * Launching goes through /usr/bin/open, never an Apple Event to the target —
 * see the note in scripts.ts on why that matters for permissions.
 *
 * virtualDesktop is deliberately ignored: macOS Spaces expose no public API,
 * and the backend declares the feature unsupported, so a value carried over
 * from a Windows machine must not fail the press.
 */
export function buildLaunchScript(config: LaunchConfig, steam?: SteamTarget | null): string {
	return wrapScript(
		`
${jsConfig(config, steam)}
        assertTrusted();

        var bundlePath = requireBundlePath(CFG.appPath);
        var target = null;
        var needLaunch = true;

        if (CFG.focusIfRunning) {
            target = findTargetWindow(CFG.appPath, bundlePath, CFG.processName, CFG.titleFilter, null);
            if (target) needLaunch = false;
        }

        if (needLaunch) {
            // Windows already open before the launch, so a single-instance app
            // reusing one is not mistaken for a freshly created window.
            var before = candidateWindows(CFG.appPath, bundlePath, CFG.processName).map(function (c) { return c.key; });

            if (STEAM) {
                // Opening the steam:// URL is what clicking Play does: Steam
                // starts its client first if it has to, and applies the game's
                // configured launch options.
                if (runTool('/usr/bin/open', [STEAM.launchUrl]) !== 0) {
                    fail('Could not ask Steam to launch "' + STEAM.name + '". Check that Steam is installed.');
                }
            } else {
                var parsed = parseIdentity(CFG.appPath);
                var args = parsed.bundleId ? ['-b', parsed.bundleId] : [bundlePath];
                if (CFG.launchArgs) {
                    args.push('--args');
                    var extra = CFG.launchArgs.split(/\\s+/);
                    for (var e = 0; e < extra.length; e++) {
                        if (extra[e].length) args.push(extra[e]);
                    }
                }
                if (runTool('/usr/bin/open', args) !== 0) {
                    fail('Could not launch "' + bundlePath + '".');
                }
            }

            // A game can spend minutes in Steam's bootstrap and shader
            // compilation before it shows a window. When the key has nothing to
            // do with that window, there is nothing to wait for: report the
            // launch rather than failing the press on a meaningless timeout.
            if (STEAM && CFG.positionMode === 'none') {
                return { ok: true, launched: true, positioned: false, movedDesktop: false, pid: 0, title: STEAM.name };
            }

            var deadline = Date.now() + Math.max(1, CFG.waitSeconds) * 1000;
            while (Date.now() < deadline) {
                target = findTargetWindow(CFG.appPath, bundlePath, CFG.processName, CFG.titleFilter, before);
                if (target) break;
                sleepMs(250);
            }
            if (!target) {
                // A single-instance app may have reused its existing window.
                target = findTargetWindow(CFG.appPath, bundlePath, CFG.processName, CFG.titleFilter, null);
            }
            if (!target) {
                fail('Timed out waiting for a window of "' + targetDescription(bundlePath) + '". Increase the wait time, or set a Process name override if the launcher differs from the windowed process.');
            }
        }

        var rect = targetRect(CFG);
        var positioned = false;
        if (rect) {
            applyRect(target.win, rect);
            positioned = true;
        } else {
            setAttrValue(target.win, 'AXMinimized', false);
        }

        raise(target);

        return {
            ok: true,
            launched: needLaunch,
            positioned: positioned,
            movedDesktop: false,
            pid: target.pid,
            title: target.title
        };
`,
		HELPERS,
	);
}

/**
 * Reads the current rectangle of the configured app's window, in the same
 * space a later position operation re-applies, so a capture round-trips.
 */
export function buildCaptureScript(config: LaunchConfig, steam?: SteamTarget | null): string {
	return wrapScript(
		`
${jsConfig(config, steam)}
        assertTrusted();

        var bundlePath = requireBundlePath(CFG.appPath);
        var target = findTargetWindow(CFG.appPath, bundlePath, CFG.processName, CFG.titleFilter, null);
        if (!target) {
            fail('"' + targetDescription(bundlePath) + '" does not appear to be running with a visible window. Start it, arrange the window, then capture.');
        }

        if (attrValue(target.win, 'AXMinimized') === true) {
            fail('The window is minimized. Restore it, arrange it, then capture.');
        }

        var frame = readFrame(target.win);
        if (!frame) fail('Could not read the window position.');

        return {
            ok: true,
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
            title: target.title,
            maximized: attrValue(target.win, 'AXFullScreen') === true
        };
`,
		HELPERS,
	);
}

/**
 * Closes the configured app's windows.
 *
 * Graceful mode presses each window's close button, which is exactly what
 * clicking the red button does — so an app with unsaved work is free to raise
 * its own save prompt. Force-quitting goes through NSRunningApplication rather
 * than the app's own quit Apple Event, for the same permission reason as
 * everything else here.
 *
 * Finding nothing to close is success: the action is idempotent.
 */
export function buildCloseScript(config: CloseConfig, steam?: SteamTarget | null): string {
	return wrapScript(
		`
${jsConfig(config, steam)}
        assertTrusted();

        var bundlePath = STEAM ? STEAM.installDir : resolveBundlePath(CFG.appPath);
        if (!bundlePath && !STEAM) {
            // Nothing installed under that identity means nothing to close.
            return { ok: true, found: 0, closed: 0, killed: 0 };
        }

        function matching() {
            var all = candidateWindows(CFG.appPath, bundlePath, CFG.processName);
            if (!CFG.titleFilter) return all;
            var needle = CFG.titleFilter.toLowerCase();
            return all.filter(function (c) { return c.title.toLowerCase().indexOf(needle) !== -1; });
        }

        function forceQuitOwners(candidates) {
            var quit = 0;
            var seen = {};
            for (var i = 0; i < candidates.length; i++) {
                var pid = candidates[i].pid;
                if (seen[pid]) continue;
                seen[pid] = true;
                try {
                    // Property access, not a call: JXA exposes ObjC
                    // zero-argument methods as properties, so adding parens
                    // would try to invoke the boolean it returned.
                    if (candidates[i].app.forceTerminate) quit++;
                } catch (e) { /* already gone */ }
            }
            return quit;
        }

        var windows = matching();
        var found = windows.length;
        var closed = 0;
        var killed = 0;

        if (found > 0) {
            if (CFG.closeMode === 'kill') {
                killed = forceQuitOwners(windows);
            } else {
                for (var i = 0; i < windows.length; i++) {
                    var win = windows[i].win;
                    var pressed = false;
                    try {
                        var buttons = win.buttons.whose({ subrole: 'AXCloseButton' })();
                        if (buttons.length) {
                            buttons[0].actions.byName('AXPress').perform();
                            pressed = true;
                        }
                    } catch (e) { pressed = false; }
                    if (!pressed) {
                        try { win.close(); pressed = true; } catch (e) { pressed = false; }
                    }
                    if (pressed) closed++;
                }

                if (CFG.closeMode === 'closeThenKill') {
                    var deadline = Date.now() + Math.max(1, CFG.waitSeconds) * 1000;
                    while (Date.now() < deadline) {
                        if (matching().length === 0) break;
                        sleepMs(250);
                    }
                    // Force-quit by whatever still owns a window now — never by
                    // the pids captured before the close, which may have exited.
                    killed = forceQuitOwners(matching());
                }
            }
        }

        return { ok: true, found: found, closed: closed, killed: killed };
`,
		HELPERS,
	);
}
