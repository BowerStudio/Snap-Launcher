import type { CloseConfig, LaunchConfig } from "../types";

/**
 * The message shown whenever Accessibility has not been granted. It names the
 * exact place to grant it because there is no way to request it
 * programmatically without presenting a dialog, which these scripts must never
 * do — the message is the entire remedy.
 */
export const ACCESSIBILITY_MESSAGE =
	"Stream Deck needs Accessibility access to control windows. Grant it in System Settings → Privacy & Security → Accessibility, then press the key again.";

/**
 * Embeds a value as a JavaScript literal. JSON.stringify already escapes
 * quotes, backslashes, and control characters; U+2028/U+2029 are legal inside
 * JSON strings but were historically illegal in JS source, so they are escaped
 * too. Non-ASCII window titles pass through as UTF-8, which is how the script
 * file is written.
 */
export function jsLiteral(value: unknown): string {
	return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Embeds the config the way psConfig does for PowerShell. */
export function jsConfig(config: LaunchConfig | CloseConfig): string {
	return `var CFG = ${jsLiteral(config)};\n`;
}

/**
 * Shared prolog for every macOS script.
 *
 * Two rules hold throughout, and both are about permissions rather than
 * capability:
 *
 * - Applications are launched with /usr/bin/open, never by scripting them.
 * - Windows are controlled only through System Events.
 *
 * Sending an Apple Event to a specific application triggers a per-application
 * TCC prompt ("Stream Deck wants to control Slack") for every app a user ever
 * puts on a key. Going through System Events means one Accessibility grant
 * covers everything.
 */
export const PROLOG = `
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');

/** Fails the whole script; the top-level catch turns this into the error JSON. */
function fail(message) {
    throw new Error(message);
}

/**
 * Gate for anything touching System Events. Deliberately uses the
 * non-prompting check: AXIsProcessTrustedWithOptions would present a dialog,
 * and it would prompt on behalf of the Stream Deck host rather than the
 * plugin. Checked per run, so granting the permission takes effect on the
 * next key press without a restart.
 */
function assertTrusted() {
    if (!$.AXIsProcessTrusted()) fail(${jsLiteral(ACCESSIBILITY_MESSAGE)});
}

function systemEvents() {
    return Application('System Events');
}

function sleepMs(ms) {
    $.NSThread.sleepForTimeInterval(ms / 1000);
}

/**
 * Runs a program with an explicit argument vector — no shell, so nothing in a
 * path or an argument can be interpreted. Returns the exit status.
 */
function runTool(launchPath, args) {
    var task = $.NSTask.alloc.init;
    task.launchPath = launchPath;
    task.arguments = args;
    task.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;
    task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
    task.launch;
    task.waitUntilExit;
    return task.terminationStatus;
}

function toStr(nsString) {
    return nsString && !nsString.isNil() ? ObjC.unwrap(nsString) : '';
}

/** Message of anything thrown, whether an Error, an NSError, or a bare string. */
function errorMessage(e) {
    if (e === null || e === undefined) return 'Unknown error.';
    if (typeof e === 'string') return e;
    if (e.message) return String(e.message);
    return String(e);
}
`;

/**
 * Wraps a script body so it emits exactly one JSON line whether it succeeds or
 * throws. osascript prints the value of the final expression, so the IIFE's
 * return value is the entire output contract.
 *
 * `body` must be a JavaScript statement sequence that returns the result object.
 * `helpers` is additional top-level source placed after the prolog — it must go
 * there, not before it, because helper code touching `$.NSWorkspace` and the
 * like depends on the prolog's ObjC.import having already run.
 */
export function wrapScript(body: string, helpers = ""): string {
	return `${PROLOG}
${helpers}
(function () {
    try {
        return JSON.stringify((function () {
${body}
        })());
    } catch (e) {
        return JSON.stringify({ ok: false, error: errorMessage(e) });
    }
})();
`;
}
