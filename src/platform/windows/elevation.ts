import type { AdminHelperStatus } from "../types";

/**
 * The administrator helper: how Snap Launcher positions windows of apps that
 * run elevated (Task Manager, Registry Editor, anything "Run as
 * administrator").
 *
 * Windows' User Interface Privilege Isolation stops a non-elevated process —
 * which the plugin always is, unless Stream Deck itself was run elevated — from
 * moving, resizing, minimizing or restoring an elevated process's windows. The
 * only way past that is for something elevated to do the moving. Prompting for
 * consent on every key press would make such a key useless, so instead the user
 * consents once, at setup, and the elevation is kept in a scheduled task:
 *
 *   - A tiny helper program is compiled from HELPER_SOURCE into
 *     %ProgramFiles%\Snap Launcher. Program Files is writable only by
 *     administrators, so nothing running as the user can replace it.
 *   - A scheduled task runs that program "with highest privileges" in the
 *     user's interactive session. Its security descriptor lets the user run it
 *     and read it, but not change it — so nothing running as the user can
 *     repoint it at a program of its own.
 *   - The plugin starts the task with one argument describing the request. The
 *     helper accepts exactly two requests — minimize window N, or move window N
 *     to a rectangle — validates every field, and touches nothing else: it
 *     reads no files, writes no files, and starts no processes. What the task
 *     makes available to anything running as the user is therefore exactly
 *     "move or minimize a top-level window", which is all it is for.
 *
 * The helper is only ever used for a window the plugin cannot move itself;
 * every other window is still moved directly, as before.
 */

/** Name of the scheduled task, in the root task folder. */
export const HELPER_TASK = "Snap Launcher Window Helper";

/** Folder under %ProgramFiles% the helper program is installed into. */
export const HELPER_DIR = "Snap Launcher";

/** File name of the helper program. */
export const HELPER_EXE = "SnapLauncherWindowHelper.exe";

/**
 * Bumped whenever HELPER_SOURCE changes, so an installed helper from an older
 * plugin is reported as needing an update rather than silently misbehaving.
 */
export const HELPER_VERSION = "1.0.1.0";

/**
 * The helper program. Requests are a single argument:
 *
 *   min:<hwnd>                         minimize the window
 *   pos:<hwnd>:<x>:<y>:<width>:<height> restore if needed, then move/resize
 *
 * Exit codes: 0 done, 2 malformed request, 3 not a live top-level window.
 */
export const HELPER_SOURCE = `
using System;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;

[assembly: AssemblyTitle("Snap Launcher Window Helper")]
[assembly: AssemblyDescription("Moves and minimizes windows of apps running as administrator for the Snap Launcher Stream Deck plugin.")]
[assembly: AssemblyVersion("${HELPER_VERSION}")]
[assembly: AssemblyFileVersion("${HELPER_VERSION}")]

static class SnapLauncherWindowHelper {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

    const int Malformed = 2;
    const int NoWindow = 3;
    const int Limit = 1000000;

    static bool Int(string s, out int v) {
        return int.TryParse(s, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out v) && v > -Limit && v < Limit;
    }

    static int Main(string[] args) {
        // Same coordinate space as the plugin's own scripts: physical pixels.
        // PER_MONITOR_AWARE_V2 (-4)
        if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();

        if (args.Length != 1 || args[0].Length > 128) return Malformed;
        string[] p = args[0].Split(':');
        if (p.Length < 2) return Malformed;

        // The whole request is validated before any window is looked at.
        bool minimize = p[0] == "min" && p.Length == 2;
        bool move = p[0] == "pos" && p.Length == 6;
        if (!minimize && !move) return Malformed;

        long handle;
        if (!long.TryParse(p[1], NumberStyles.None, CultureInfo.InvariantCulture, out handle) || handle <= 0) return Malformed;

        int x = 0, y = 0, w = 0, ht = 0;
        if (move && (!Int(p[2], out x) || !Int(p[3], out y) || !Int(p[4], out w) || !Int(p[5], out ht) || w <= 0 || ht <= 0)) return Malformed;

        IntPtr h = new IntPtr(handle);
        // GA_ROOT (2): top-level windows only - never a control inside one.
        if (!IsWindow(h) || GetAncestor(h, 2) != h) return NoWindow;

        if (minimize) {
            // SW_MINIMIZE (6)
            ShowWindow(h, 6);
            return 0;
        }

        if (IsIconic(h) || IsZoomed(h)) {
            // SW_RESTORE (9)
            ShowWindow(h, 9);
            Thread.Sleep(120);
        }
        // SWP_NOZORDER (0x4) | SWP_NOACTIVATE (0x10)
        SetWindowPos(h, IntPtr.Zero, x, y, w, ht, 0x14);
        return 0;
    }
}
`;

/** Matches a Windows security identifier, the only user data the installer embeds. */
const SID_PATTERN = /^S-1-\d+(-\d+)+$/;

/**
 * The script that runs elevated to install (or update) the helper. Exit codes:
 * 0 installed, 10 bad input, 11 compile failed, 12 task registration failed.
 *
 * userSid is the user who asked for the helper, captured before elevating: a
 * standard user who types an administrator's credentials at the prompt gets an
 * elevated process running as that administrator, and the task must still run
 * in, and be runnable by, the original user.
 */
export function buildInstallerScript(userSid: string): string {
	if (!SID_PATTERN.test(userSid)) {
		throw new Error(`Not a security identifier: ${userSid}`);
	}
	return `
$ErrorActionPreference = 'Stop'
$sid = '${userSid}'
$dir = Join-Path $env:ProgramFiles '${HELPER_DIR}'
$exe = Join-Path $dir '${HELPER_EXE}'
$source = @'
${HELPER_SOURCE}
'@

try {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if (Test-Path -LiteralPath $exe) { Remove-Item -LiteralPath $exe -Force }
    Add-Type -TypeDefinition $source -OutputAssembly $exe -OutputType WindowsApplication
} catch { exit 11 }

try {
    $account = (New-Object System.Security.Principal.SecurityIdentifier $sid).Translate([System.Security.Principal.NTAccount]).Value
    $svc = New-Object -ComObject 'Schedule.Service'
    $svc.Connect()
    $def = $svc.NewTask(0)
    $def.RegistrationInfo.Author = 'Snap Launcher'
    $def.RegistrationInfo.Description = 'Lets the Snap Launcher Stream Deck plugin move and minimize windows of apps running as administrator. Remove it from the plugin''s key settings.'
    $def.Principal.UserId = $account
    $def.Principal.LogonType = 3   # TASK_LOGON_INTERACTIVE_TOKEN: the user's own session
    $def.Principal.RunLevel = 1    # TASK_RUNLEVEL_HIGHEST
    $s = $def.Settings
    $s.Enabled = $true
    $s.Hidden = $true
    $s.AllowDemandStart = $true
    $s.StartWhenAvailable = $false
    $s.DisallowStartIfOnBatteries = $false
    $s.StopIfGoingOnBatteries = $false
    $s.IdleSettings.StopOnIdleEnd = $false
    $s.ExecutionTimeLimit = 'PT1M'
    $s.MultipleInstances = 0       # TASK_INSTANCES_PARALLEL
    $s.Priority = 4                # normal, not the below-normal default
    $action = $def.Actions.Create(0)
    $action.Path = $exe
    $action.Arguments = '$(Arg0)'
    # Full control for SYSTEM and Administrators; the user may read and run
    # the task, never modify it.
    $sddl = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;' + $sid + ')'
    # TASK_CREATE_OR_UPDATE (6), TASK_LOGON_INTERACTIVE_TOKEN (3)
    [void]$svc.GetFolder('\\').RegisterTaskDefinition('${HELPER_TASK}', $def, 6, $account, $null, 3, $sddl)
} catch { exit 12 }

exit 0
`;
}

/** The script that runs elevated to remove the helper. Exit codes: 0 removed, 13 failed. */
export function buildUninstallerScript(): string {
	return `
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:ProgramFiles '${HELPER_DIR}'
try {
    $svc = New-Object -ComObject 'Schedule.Service'
    $svc.Connect()
    try { $svc.GetFolder('\\').DeleteTask('${HELPER_TASK}', 0) } catch { }
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
} catch { exit 13 }
exit 0
`;
}

/**
 * PowerShell for the launch script: finds the installed helper and runs one
 * request through it, waiting for it to finish.
 */
export const HELPER_CLIENT = `
function Get-ElevationHelper {
    try {
        $svc = New-Object -ComObject 'Schedule.Service'
        $svc.Connect()
        $task = $svc.GetFolder('\\').GetTask('${HELPER_TASK}')
        if (-not $task.Enabled) { return $null }
        return $task
    } catch { return $null }
}

# Runs one request through the helper and waits for it to exit. Returns the
# helper's exit code, or -1 if it did not finish in time.
#
# The running instance stops being refreshable once the helper has exited;
# until the task records the result, LastTaskResult still reads
# SCHED_S_TASK_RUNNING (0x41301).
function Invoke-ElevationHelper($task, [string]$request) {
    $run = $task.RunEx($request, 0, 0, $null)
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 30
        $finished = $false
        try { $run.Refresh() } catch { $finished = $true }
        if ($finished) {
            $code = [int]$task.LastTaskResult
            if ($code -ne 0x41301) { return $code }
        }
    }
    return -1
}

# The helper's answer, as the launch script needs it: nothing on success, a
# legible failure otherwise.
function Invoke-HelperRequest($task, [string]$request) {
    $code = Invoke-ElevationHelper $task $request
    if ($code -eq 0) { return }
    if ($code -eq 3) { throw 'The window closed before it could be moved.' }
    if ($code -eq -1) { throw 'The administrator helper did not respond. Remove it and set it up again in the key settings.' }
    throw ('The administrator helper failed (code ' + $code + '). Remove it and set it up again in the key settings.')
}
`;

/**
 * Reports whether the helper is installed, current, and runnable by this user.
 * Runs unelevated.
 */
export function buildHelperStatusScript(): string {
	return `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$exe = Join-Path (Join-Path $env:ProgramFiles '${HELPER_DIR}') '${HELPER_EXE}'
$task = $null
try {
    $svc = New-Object -ComObject 'Schedule.Service'
    $svc.Connect()
    $task = $svc.GetFolder('\\').GetTask('${HELPER_TASK}')
} catch { }
$version = ''
if (Test-Path -LiteralPath $exe) {
    try { $version = [string](Get-Item -LiteralPath $exe).VersionInfo.FileVersion } catch { }
}
$out = @{ ok = $true; task = [bool]$task; exe = [bool]$version; version = $version; current = ($version -eq '${HELPER_VERSION}') }
Write-Output (ConvertTo-Json -InputObject $out -Compress)
`;
}

/**
 * Runs an installer/uninstaller elevated, which shows the Windows consent
 * prompt, and reports how it went. Runs unelevated; the elevated process's
 * output cannot be captured, so it reports by exit code alone.
 *
 * The elevated script travels as -EncodedCommand rather than as a file: a
 * script file written to a user-writable folder could be swapped between the
 * prompt being answered and the file being read.
 */
export function buildElevateScript(elevatedScript: string): string {
	const encoded = Buffer.from(elevatedScript, "utf16le").toString("base64");
	return `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
try {
    $p = Start-Process -FilePath $ps -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${encoded}')
    $out = @{ ok = $true; exitCode = [int]$p.ExitCode }
} catch {
    # Declining the prompt surfaces here, as ERROR_CANCELLED.
    $out = @{ ok = $false; cancelled = $true; error = $_.Exception.Message }
}
Write-Output (ConvertTo-Json -InputObject $out -Compress)
`;
}

/** The current user's SID, read unelevated so the installer knows who asked. */
export function buildUserSidScript(): string {
	return `
$ErrorActionPreference = 'Stop'
$out = @{ ok = $true; sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
Write-Output (ConvertTo-Json -InputObject $out -Compress)
`;
}

/** What buildHelperStatusScript() reports. */
export type RawHelperStatus = { ok: boolean; task: boolean; exe: boolean; version: string; current: boolean };

/** What buildElevateScript() reports. */
export type ElevateResult = { ok: true; exitCode: number } | { ok: false; cancelled: boolean; error: string };

/** Turns the raw status into what the Property Inspector shows. */
export function describeHelperStatus(raw: RawHelperStatus): AdminHelperStatus {
	if (raw.task && raw.exe && raw.current) {
		return {
			supported: true,
			installed: true,
			message: "Set up — apps running as administrator are positioned like any other.",
		};
	}
	if (raw.task && raw.exe) {
		return {
			supported: true,
			installed: true,
			message: "Set up by an older version of the plugin — click Set up to update it.",
		};
	}
	if (raw.task || raw.exe) {
		return { supported: true, installed: false, message: "Only partly set up — click Set up to repair it." };
	}
	return { supported: true, installed: false, message: "Not set up." };
}

/** What the installer/uninstaller exit codes mean, for the status line. */
export function describeHelperExit(code: number): string {
	switch (code) {
		case 0:
			return "";
		case 10:
			return "The setup was given bad input.";
		case 11:
			return "The helper program could not be built.";
		case 12:
			return "The scheduled task could not be registered.";
		case 13:
			return "The helper could not be removed.";
		default:
			return `The setup failed (exit code ${code}).`;
	}
}
