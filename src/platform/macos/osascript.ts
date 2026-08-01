import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Absolute path so the runner never depends on the plugin host's PATH. */
const OSASCRIPT = "/usr/bin/osascript";

/**
 * Scans stdout backwards for the last line that parses as JSON. JXA writes the
 * result of the last expression to stdout, but anything the OS logs on the way
 * (deprecation notices, TCC chatter) lands there too, so position is not
 * enough — the line has to actually parse.
 *
 * Exported for tests, which cover it against captured osascript output.
 */
export function parseLastJsonLine<T>(stdout: string): { ok: true; value: T } | { ok: false; lastLine: string } {
	const lines = stdout
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line.startsWith("{") || line.startsWith("[")) {
			try {
				return { ok: true, value: JSON.parse(line) as T };
			} catch {
				// keep scanning earlier lines
			}
		}
	}

	return { ok: false, lastLine: lines.length ? lines[lines.length - 1] : "" };
}

/**
 * execFile reports a timeout by killing the child, not via a distinct code.
 * Exported for tests.
 */
export function isTimeout(error: (Error & { killed?: boolean; signal?: string | null }) | null): boolean {
	return !!error && (error.killed === true || error.signal === "SIGTERM");
}

/** Exported for tests so the wording stays pinned. */
export function timeoutMessage(timeoutMs: number): string {
	return `The operation timed out after ${Math.round(timeoutMs / 1000)}s.`;
}

/**
 * Runs a JXA script through osascript via a temp file — scripts are far larger
 * than is comfortable on a command line, and a file keeps quoting out of the
 * picture entirely. Parses the single JSON line the script is expected to emit.
 *
 * This mirrors runPowerShell's contract exactly: one process, one JSON line,
 * bounded by timeoutMs, no interactive prompts. Kept separate from it rather
 * than shared because the two have nothing in common but their shape.
 */
export function runOsascript<T>(script: string, timeoutMs: number): Promise<T> {
	let scriptDir: string;
	let scriptFile: string;
	try {
		scriptDir = mkdtempSync(path.join(tmpdir(), "snap-launcher-"));
		scriptFile = path.join(scriptDir, `run-${randomBytes(6).toString("hex")}.js`);
		writeFileSync(scriptFile, script, "utf8");
	} catch (e) {
		return Promise.reject(new Error(`Could not write the script to a temp file: ${e instanceof Error ? e.message : String(e)}`));
	}

	return new Promise<T>((resolve, reject) => {
		execFile(
			OSASCRIPT,
			["-l", "JavaScript", scriptFile],
			{ timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				try {
					rmSync(scriptDir, { recursive: true, force: true });
				} catch {
					// best effort; the OS temp cleaner will get it eventually
				}

				// A timed-out script may still have printed a partial line; the
				// timeout is the more useful thing to report either way.
				if (isTimeout(error)) {
					reject(new Error(timeoutMessage(timeoutMs)));
					return;
				}

				const parsed = parseLastJsonLine<T>((stdout ?? "").toString());
				if (parsed.ok) {
					resolve(parsed.value);
					return;
				}

				// No JSON: a syntax error, a missing osascript, or a script that
				// died before its try/catch could report. stderr is where
				// osascript puts all three.
				const details = (stderr ?? "").toString().trim();
				if (error) {
					reject(new Error(details || error.message));
				} else {
					reject(new Error("osascript produced no parsable output." + (details ? ` ${details.slice(0, 300)}` : "")));
				}
			},
		);
	});
}
