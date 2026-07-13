import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type PositionMode = "none" | "zone" | "custom";

/**
 * Configuration passed into the PowerShell scripts. All fields are normalized
 * (trimmed strings, clamped numbers, validated mode/zone) by toConfig() in
 * settings.ts before reaching this module.
 */
export type LaunchConfig = {
	appPath: string;
	launchArgs: string;
	titleFilter: string;
	processName: string;
	focusIfRunning: boolean;
	/** How to position the window after launch/focus. */
	positionMode: PositionMode;
	/** Display device name (e.g. \\.\DISPLAY2) or "primary". Zone mode only. */
	monitorId: string;
	/** One of the 9 snap zones. Zone mode only. */
	zone: string;
	waitSeconds: number;
	/** Explicit rectangle. Custom mode only. */
	x: number;
	y: number;
	width: number;
	height: number;
};

export type LaunchResult =
	| { ok: true; launched: boolean; positioned: boolean; pid: number; title: string }
	| { ok: false; error: string };

export type CaptureResult =
	| { ok: true; x: number; y: number; width: number; height: number; title: string; maximized: boolean }
	| { ok: false; error: string };

export type RunningApp = { name: string; title: string; path: string | null; display?: string };

export type MonitorEntry = {
	deviceName: string;
	left: number;
	top: number;
	width: number;
	height: number;
	workLeft: number;
	workTop: number;
	workWidth: number;
	workHeight: number;
	isPrimary: boolean;
};

/**
 * Shared prolog: strict errors, no progress noise, UTF-8 stdout so non-ASCII
 * window titles survive the trip back to Node.
 */
const PROLOG = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
`;

/**
 * Win32 interop + per-monitor-v2 DPI awareness. With PER_MONITOR_AWARE_V2 set,
 * GetWindowRect and SetWindowPos both speak physical pixels in virtual-desktop
 * coordinates (negative values are valid for monitors left of / above the
 * primary), so captured rectangles round-trip exactly.
 *
 * WindowFinder enumerates visible, titled top-level windows in z-order. Store
 * (UWP) app windows are hosted by ApplicationFrameHost: the outer frame — the
 * window that must be moved, resized, and activated — belongs to the host
 * process, while the app itself only owns a child CoreWindow. Those frames are
 * attributed to the hosted app's process so callers can match on the app.
 */
const NATIVE = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

public static class Native {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, ref RECT lpRect);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, ref RECT pvAttribute, int cbAttribute);
}

public class AppWindow {
    public IntPtr Handle;
    public int ProcessId;
    public string Title;
    public string ProcessName;
    public string ProcessPath;
}

public static class WindowFinder {
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr hWnd, EnumProc cb, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetShellWindow();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr h);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageName(IntPtr hProcess, uint flags, StringBuilder exeName, ref uint size);

    private static string GetTitle(IntPtr hWnd) {
        int len = GetWindowTextLength(hWnd);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    // Paths of protected/elevated processes are unreadable and come back "";
    // such windows are skipped (they could not be repositioned anyway - UIPI).
    private static string PathOf(int pid, Dictionary<int, string> cache) {
        string path;
        if (cache.TryGetValue(pid, out path)) return path;
        path = "";
        IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (h != IntPtr.Zero) {
            try {
                StringBuilder sb = new StringBuilder(1024);
                uint size = 1024;
                if (QueryFullProcessImageName(h, 0, sb, ref size)) path = sb.ToString(0, (int)size);
            } finally { CloseHandle(h); }
        }
        cache[pid] = path;
        return path;
    }

    public static List<AppWindow> ListAll() {
        List<AppWindow> results = new List<AppWindow>();
        Dictionary<int, string> paths = new Dictionary<int, string>();
        IntPtr shell = GetShellWindow();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (hWnd == shell || !IsWindowVisible(hWnd)) return true;
            string title = GetTitle(hWnd);
            if (title.Length == 0) return true;
            uint rawPid;
            GetWindowThreadProcessId(hWnd, out rawPid);
            int pid = (int)rawPid;
            string path = PathOf(pid, paths);
            if (path.Length == 0) return true;
            string name = Path.GetFileNameWithoutExtension(path);
            if (string.Equals(name, "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) {
                // Attribute the frame to the hosted app: the first child window
                // owned by a different process is the app's CoreWindow.
                int hostedPid = 0;
                EnumChildWindows(hWnd, delegate(IntPtr child, IntPtr l) {
                    uint childPid;
                    GetWindowThreadProcessId(child, out childPid);
                    if ((int)childPid != pid) { hostedPid = (int)childPid; return false; }
                    return true;
                }, IntPtr.Zero);
                if (hostedPid != 0) {
                    string hostedPath = PathOf(hostedPid, paths);
                    if (hostedPath.Length > 0) {
                        results.Add(new AppWindow {
                            Handle = hWnd,
                            ProcessId = hostedPid,
                            Title = title,
                            ProcessName = Path.GetFileNameWithoutExtension(hostedPath),
                            ProcessPath = hostedPath
                        });
                        return true;
                    }
                }
            }
            results.Add(new AppWindow { Handle = hWnd, ProcessId = pid, Title = title, ProcessName = name, ProcessPath = path });
            return true;
        }, IntPtr.Zero);
        return results;
    }
}

public class MonitorData {
    public string DeviceName;
    public int Left;
    public int Top;
    public int Width;
    public int Height;
    public int WorkLeft;
    public int WorkTop;
    public int WorkWidth;
    public int WorkHeight;
    public bool IsPrimary;
}

public static class MonitorFinder {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MONITORINFOEX {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);

    // With per-monitor-v2 DPI awareness set below, bounds and work areas are
    // physical virtual-desktop pixels - the same space SetWindowPos speaks.
    public static List<MonitorData> ListAll() {
        List<MonitorData> results = new List<MonitorData>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr hMon, IntPtr hdc, ref RECT rect, IntPtr data) {
            MONITORINFOEX info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfo(hMon, ref info)) {
                MonitorData d = new MonitorData();
                d.DeviceName = info.szDevice;
                d.Left = info.rcMonitor.Left;
                d.Top = info.rcMonitor.Top;
                d.Width = info.rcMonitor.Right - info.rcMonitor.Left;
                d.Height = info.rcMonitor.Bottom - info.rcMonitor.Top;
                d.WorkLeft = info.rcWork.Left;
                d.WorkTop = info.rcWork.Top;
                d.WorkWidth = info.rcWork.Right - info.rcWork.Left;
                d.WorkHeight = info.rcWork.Bottom - info.rcWork.Top;
                d.IsPrimary = (info.dwFlags & 1) != 0; // MONITORINFOF_PRIMARY
                results.Add(d);
            }
            return true;
        }, IntPtr.Zero);
        return results;
    }
}
'@

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4; falls back for pre-1703 builds.
try {
    [void][Native]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
} catch {
    try { [void][Native]::SetProcessDPIAware() } catch { }
}
`;

/**
 * Helpers for Microsoft Store (MSIX/UWP) apps, which are addressed by
 * AppUserModelId ("FamilyName!AppId") and launched through the shell's
 * AppsFolder rather than by exe path — their executables under
 * C:\Program Files\WindowsApps are ACL-protected.
 */
const APPX = `
$script:AppxPackages = $null
function Get-AppxPackagesCached {
    if ($null -eq $script:AppxPackages) {
        try { $script:AppxPackages = @(Get-AppxPackage) } catch { $script:AppxPackages = @() }
    }
    return $script:AppxPackages
}

function Get-PackageApplications($pkg) {
    try {
        return @((Get-AppxPackageManifest $pkg -ErrorAction Stop).Package.Applications.Application | Where-Object { $_ })
    } catch { return @() }
}

# Accepts 'shell:AppsFolder\\<AUMID>' or a bare AUMID (contains '!', no slashes);
# anything else returns $null and is treated as a classic exe/.lnk path.
function Get-TargetAumid([string]$p) {
    if (-not $p) { return $null }
    $prefix = 'shell:appsfolder\\'
    if ($p.Length -gt $prefix.Length -and $p.Substring(0, $prefix.Length).ToLower() -eq $prefix) {
        return $p.Substring($prefix.Length)
    }
    if ($p.Contains('!') -and -not $p.Contains('\\') -and -not $p.Contains('/')) { return $p }
    return $null
}

function Get-PackageForAumid([string]$aumid) {
    $bang = $aumid.IndexOf('!')
    if ($bang -lt 1) { return $null }
    $family = $aumid.Substring(0, $bang)
    return (Get-AppxPackagesCached | Where-Object { $_.PackageFamilyName -eq $family } | Select-Object -First 1)
}

# True for exe paths that cannot be launched directly (ACL-protected package
# locations) and need shell:AppsFolder activation instead.
function Test-PackagedPath([string]$p) {
    if (-not $p) { return $false }
    if ($p -like '*\\WindowsApps\\*') { return $true }
    $win = $env:SystemRoot
    if (-not $win) { $win = 'C:\\Windows' }
    if ($p.StartsWith((Join-Path $win 'SystemApps') + '\\', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($p.StartsWith((Join-Path $win 'ImmersiveControlPanel') + '\\', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $false
}

# Maps an exe path under a package's install location back to that package's
# AUMID and display name (preferring the manifest application whose executable
# matches). Returns $null when the path belongs to no installed package.
function Resolve-PathPackage([string]$exePath) {
    foreach ($pkg in Get-AppxPackagesCached) {
        $loc = $pkg.InstallLocation
        if (-not $loc) { continue }
        if (-not $exePath.StartsWith($loc + '\\', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        $apps = Get-PackageApplications $pkg
        if ($apps.Count -eq 0) { return $null }
        $exeName = [System.IO.Path]::GetFileName($exePath)
        $app = $apps | Where-Object { $_.Executable -and ([System.IO.Path]::GetFileName([string]$_.Executable) -eq $exeName) } | Select-Object -First 1
        if (-not $app) { $app = $apps[0] }
        if (-not $app.Id) { return $null }
        $disp = $null
        try {
            $d = [string](Get-AppxPackageManifest $pkg -ErrorAction Stop).Package.Properties.DisplayName
            # Some packages localize via ms-resource: URIs, which are useless as-is.
            if ($d -and -not $d.StartsWith('ms-resource')) { $disp = $d.Trim() }
        } catch { }
        return [pscustomobject]@{ Aumid = ($pkg.PackageFamilyName + '!' + [string]$app.Id); Display = $disp }
    }
    return $null
}
`;

/**
 * Pure positioning helpers (no Win32 interop), exported so tests can exercise
 * them directly. Get-ZoneRect maps a snap zone onto a work area; right/bottom
 * zones extend to the work-area edge so halves tile exactly on odd dimensions.
 * Resolve-TargetMonitor picks the configured monitor from a list, falling back
 * to the primary (then the first) when the saved monitor is absent.
 */
export const ZONE_HELPERS = `
function Get-ZoneRect([int]$waLeft, [int]$waTop, [int]$waWidth, [int]$waHeight, [string]$zone) {
    $midX = $waLeft + [int][Math]::Floor($waWidth / 2)
    $midY = $waTop + [int][Math]::Floor($waHeight / 2)
    $right = $waLeft + $waWidth
    $bottom = $waTop + $waHeight
    switch ($zone) {
        'left'        { return @{ x = $waLeft; y = $waTop; width = ($midX - $waLeft); height = $waHeight } }
        'right'       { return @{ x = $midX; y = $waTop; width = ($right - $midX); height = $waHeight } }
        'top'         { return @{ x = $waLeft; y = $waTop; width = $waWidth; height = ($midY - $waTop) } }
        'bottom'      { return @{ x = $waLeft; y = $midY; width = $waWidth; height = ($bottom - $midY) } }
        'topLeft'     { return @{ x = $waLeft; y = $waTop; width = ($midX - $waLeft); height = ($midY - $waTop) } }
        'topRight'    { return @{ x = $midX; y = $waTop; width = ($right - $midX); height = ($midY - $waTop) } }
        'bottomLeft'  { return @{ x = $waLeft; y = $midY; width = ($midX - $waLeft); height = ($bottom - $midY) } }
        'bottomRight' { return @{ x = $midX; y = $midY; width = ($right - $midX); height = ($bottom - $midY) } }
        default       { return @{ x = $waLeft; y = $waTop; width = $waWidth; height = $waHeight } }
    }
}

function Resolve-TargetMonitor($monitors, [string]$monitorId) {
    if ($monitorId -and $monitorId -ne 'primary') {
        $m = @($monitors | Where-Object { $_.DeviceName -eq $monitorId }) | Select-Object -First 1
        if ($m) { return $m }
    }
    $m = @($monitors | Where-Object { $_.IsPrimary }) | Select-Object -First 1
    if ($m) { return $m }
    return @($monitors) | Select-Object -First 1
}
`;

/**
 * Resolves what to launch and how to recognize its windows, then defines
 * Find-TargetWindow over WindowFinder::ListAll().
 *
 * Classic apps match by process name (from the exe/.lnk or the override).
 * Store apps often launch through a stub whose name differs from the windowed
 * process (e.g. WhatsApp.Root.exe spawns WhatsApp.exe), so without an explicit
 * override they match any window whose owning process lives inside the
 * package's install location.
 */
const FIND_WINDOW = `
function Resolve-TargetExe([string]$p) {
    if ($p -and $p.ToLower().EndsWith('.lnk')) {
        try {
            $sh = New-Object -ComObject WScript.Shell
            $t = $sh.CreateShortcut($p).TargetPath
            if ($t) { return $t }
        } catch { }
    }
    return $p
}

function Get-CandidateWindows {
    $wins = @([WindowFinder]::ListAll())
    if ($procName) {
        return @($wins | Where-Object { $_.ProcessName -eq $procName })
    }
    return @($wins | Where-Object { $_.ProcessPath.StartsWith($pkgRoot, [System.StringComparison]::OrdinalIgnoreCase) })
}

function Find-TargetWindow([string]$titleFilter, [long[]]$exclude) {
    $wins = Get-CandidateWindows
    if ($titleFilter) {
        $pattern = '*' + [System.Management.Automation.WildcardPattern]::Escape($titleFilter) + '*'
        $wins = @($wins | Where-Object { $_.Title -like $pattern })
    }
    if ($exclude -and $exclude.Count -gt 0) {
        $wins = @($wins | Where-Object { $exclude -notcontains $_.Handle.ToInt64() })
    }
    $w = $wins | Select-Object -First 1
    if (-not $w) { return $null }
    return [pscustomobject]@{ MainWindowHandle = $w.Handle; Id = $w.ProcessId; MainWindowTitle = $w.Title }
}

$aumid = Get-TargetAumid $cfg.appPath
$exePath = $null
if (-not $aumid) {
    $exePath = Resolve-TargetExe $cfg.appPath
    if (Test-PackagedPath $exePath) {
        $a = Resolve-PathPackage $exePath
        if ($a) { $aumid = $a.Aumid }
    }
}

$procName = $cfg.processName
if ($procName -and $procName.ToLower().EndsWith('.exe')) { $procName = $procName.Substring(0, $procName.Length - 4) }

$pkgRoot = $null
if ($aumid) {
    $pkg = Get-PackageForAumid $aumid
    if ($pkg -and $pkg.InstallLocation) { $pkgRoot = $pkg.InstallLocation + '\\' }
    if (-not $procName -and -not $pkgRoot) {
        throw ('Could not find an installed Store package for "' + $aumid + '". Re-pick the app, or set a Process name override in the key settings.')
    }
} elseif (-not $procName) {
    $procName = [System.IO.Path]::GetFileNameWithoutExtension($exePath)
    if (-not $procName) { throw 'Could not determine a process name from the application path.' }
}

$targetDesc = if ($procName) { $procName } else { $aumid }
`;

/** Embeds the config as a single-quoted JSON literal ('' escapes quotes). */
function psConfig(config: LaunchConfig): string {
	const json = JSON.stringify(config).replace(/'/g, "''");
	return "$cfg = ConvertFrom-Json '" + json + "'\n";
}

/**
 * Launches (or focuses) the configured application, waits for its window, then
 * restores + repositions it. Emits exactly one JSON line on stdout.
 */
export function buildLaunchScript(config: LaunchConfig): string {
	return `
${PROLOG}
${psConfig(config)}
${NATIVE}
${APPX}
${ZONE_HELPERS}
${FIND_WINDOW}

# Windows 10/11 windows carry invisible resize borders: GetWindowRect extends
# past the visible frame (typically 7px left/right/bottom, DPI-scaled), and
# SetWindowPos speaks the same outer coordinates. Native Snap compensates so
# the VISIBLE frame fills the zone; do the same. DWMWA_EXTENDED_FRAME_BOUNDS
# (9) is the visible rect; borderless windows and DWM failures yield zero
# margins, leaving the rect unchanged.
function Get-ZoneTarget($h, $rect) {
    $t = @{ x = [int]$rect.x; y = [int]$rect.y; width = [int]$rect.width; height = [int]$rect.height }
    $wr = New-Object RECT
    if (-not [Native]::GetWindowRect($h, [ref]$wr)) { return $t }
    $ef = New-Object RECT
    $hr = [Native]::DwmGetWindowAttribute($h, 9, [ref]$ef, [System.Runtime.InteropServices.Marshal]::SizeOf([type][RECT]))
    if ($hr -ne 0) { return $t }
    $mLeft = $ef.Left - $wr.Left
    $mTop = $ef.Top - $wr.Top
    $mRight = $wr.Right - $ef.Right
    $mBottom = $wr.Bottom - $ef.Bottom
    # Sanity: margins are small and non-negative; a wild value means the DWM
    # rect is not comparable (e.g. cloaked window) - skip adjustment.
    if ($mLeft -lt 0 -or $mTop -lt 0 -or $mRight -lt 0 -or $mBottom -lt 0) { return $t }
    if ($mLeft -gt 64 -or $mTop -gt 64 -or $mRight -gt 64 -or $mBottom -gt 64) { return $t }
    $t.x = $t.x - $mLeft
    $t.y = $t.y - $mTop
    $t.width = $t.width + $mLeft + $mRight
    $t.height = $t.height + $mTop + $mBottom
    return $t
}

try {
    $target = $null
    $needLaunch = $true

    if ($cfg.focusIfRunning) {
        $target = Find-TargetWindow $cfg.titleFilter @()
        if ($target) { $needLaunch = $false }
    }

    if ($needLaunch) {
        $before = @(Get-CandidateWindows | ForEach-Object { $_.Handle.ToInt64() })

        if ($aumid) {
            # Store apps activate via the shell moniker; a plain exe launch is denied.
            $sp = @{ FilePath = ('shell:AppsFolder\\' + $aumid) }
            if ($cfg.launchArgs) { $sp['ArgumentList'] = $cfg.launchArgs }
        } else {
            $sp = @{ FilePath = $cfg.appPath }
            if ($cfg.launchArgs) { $sp['ArgumentList'] = $cfg.launchArgs }
            if (-not $cfg.appPath.ToLower().EndsWith('.lnk')) {
                try {
                    $dir = [System.IO.Path]::GetDirectoryName($cfg.appPath)
                    if ($dir -and (Test-Path -LiteralPath $dir)) { $sp['WorkingDirectory'] = $dir }
                } catch { }
            }
        }
        Start-Process @sp | Out-Null

        $deadline = (Get-Date).AddSeconds([Math]::Max(1, [int]$cfg.waitSeconds))
        while ((Get-Date) -lt $deadline) {
            $target = Find-TargetWindow $cfg.titleFilter $before
            if ($target) { break }
            Start-Sleep -Milliseconds 250
        }
        if (-not $target) {
            # Single-instance apps (e.g. Chrome, most Store apps) may reuse the
            # pre-existing window.
            $target = Find-TargetWindow $cfg.titleFilter @()
        }
        if (-not $target) {
            throw ('Timed out waiting for a window of "' + $targetDesc + '". Increase the wait time, or set a Process name override if the launcher differs from the windowed process.')
        }
    }

    $hwnd = $target.MainWindowHandle

    $rect = $null
    if ($cfg.positionMode -eq 'custom') {
        $rect = @{ x = [int]$cfg.x; y = [int]$cfg.y; width = [int]$cfg.width; height = [int]$cfg.height }
    } elseif ($cfg.positionMode -eq 'zone') {
        $mons = @([MonitorFinder]::ListAll())
        if ($mons.Count -gt 0) {
            # Resolved at press time: a missing monitor falls back to primary,
            # and layout/resolution changes are picked up automatically.
            $mon = Resolve-TargetMonitor $mons $cfg.monitorId
            $rect = Get-ZoneRect ([int]$mon.WorkLeft) ([int]$mon.WorkTop) ([int]$mon.WorkWidth) ([int]$mon.WorkHeight) $cfg.zone
        } else {
            throw 'No monitors could be enumerated.'
        }
    }

    if ([Native]::IsIconic($hwnd) -or ($rect -and [Native]::IsZoomed($hwnd))) {
        [void][Native]::ShowWindow($hwnd, 9)
        Start-Sleep -Milliseconds 120
    }

    $applied = $false
    if ($rect) {
        # Custom mode re-applies captured GetWindowRect values verbatim; zone
        # mode compensates for the window's invisible borders so the visible
        # frame fills the zone.
        # (Named $posTarget, not $target: $target still holds the window info
        # - Id/MainWindowTitle - needed for the result JSON below.)
        if ($cfg.positionMode -eq 'zone') { $posTarget = Get-ZoneTarget $hwnd $rect } else { $posTarget = $rect }
        # SWP_NOZORDER (0x4) | SWP_NOACTIVATE (0x10)
        [void][Native]::SetWindowPos($hwnd, [IntPtr]::Zero, [int]$posTarget.x, [int]$posTarget.y, [int]$posTarget.width, [int]$posTarget.height, 0x0014)
        Start-Sleep -Milliseconds 120

        # Crossing into a monitor with a different DPI can rescale the window
        # and its invisible borders; recompute the target once and reapply if
        # the window is not where it should be.
        if ($cfg.positionMode -eq 'zone') { $posTarget = Get-ZoneTarget $hwnd $rect }
        $rc = New-Object RECT
        [void][Native]::GetWindowRect($hwnd, [ref]$rc)
        if (($rc.Left -ne [int]$posTarget.x) -or ($rc.Top -ne [int]$posTarget.y) -or (($rc.Right - $rc.Left) -ne [int]$posTarget.width) -or (($rc.Bottom - $rc.Top) -ne [int]$posTarget.height)) {
            [void][Native]::SetWindowPos($hwnd, [IntPtr]::Zero, [int]$posTarget.x, [int]$posTarget.y, [int]$posTarget.width, [int]$posTarget.height, 0x0014)
        }
        $applied = $true
    }

    [void][Native]::SetForegroundWindow($hwnd)

    $out = @{ ok = $true; launched = $needLaunch; positioned = $applied; pid = $target.Id; title = $target.MainWindowTitle }
    Write-Output (ConvertTo-Json -InputObject $out -Compress)
} catch {
    $out = @{ ok = $false; error = $_.Exception.Message }
    Write-Output (ConvertTo-Json -InputObject $out -Compress)
}
`;
}

/**
 * Reads the current rectangle of the configured app's window. Refuses while
 * minimized (the rect would be meaningless); flags maximized captures.
 */
export function buildCaptureScript(config: LaunchConfig): string {
	return `
${PROLOG}
${psConfig(config)}
${NATIVE}
${APPX}
${FIND_WINDOW}

try {
    $target = Find-TargetWindow $cfg.titleFilter @()
    if (-not $target) {
        throw ('"' + $targetDesc + '" does not appear to be running with a visible window. Start it, arrange the window, then capture.')
    }

    $hwnd = $target.MainWindowHandle
    if ([Native]::IsIconic($hwnd)) { throw 'The window is minimized. Restore it, arrange it, then capture.' }

    $rc = New-Object RECT
    [void][Native]::GetWindowRect($hwnd, [ref]$rc)

    $out = @{
        ok = $true
        x = $rc.Left
        y = $rc.Top
        width = ($rc.Right - $rc.Left)
        height = ($rc.Bottom - $rc.Top)
        title = $target.MainWindowTitle
        maximized = [bool][Native]::IsZoomed($hwnd)
    }
    Write-Output (ConvertTo-Json -InputObject $out -Compress)
} catch {
    $out = @{ ok = $false; error = $_.Exception.Message }
    Write-Output (ConvertTo-Json -InputObject $out -Compress)
}
`;
}

/**
 * Lists processes that own a visible titled window (one entry per process,
 * including Store apps hosted by ApplicationFrameHost). Store app entries
 * carry a shell:AppsFolder\<AUMID> value so they can be launched later;
 * windows of protected/elevated processes are omitted entirely.
 */
export function buildListScript(): string {
	return `
${PROLOG}
${NATIVE}
${APPX}
try {
    $items = New-Object System.Collections.Generic.List[object]
    $seenPid = @{}
    foreach ($w in [WindowFinder]::ListAll()) {
        # WebView2 component windows carry their host app's title (e.g. an
        # "msedgewebview2 - WhatsApp" entry alongside the real WhatsApp entry),
        # but launching the bare runtime shows nothing - never offer them.
        if ($w.ProcessName -eq 'msedgewebview2') { continue }
        if ($seenPid.ContainsKey($w.ProcessId)) { continue }
        $seenPid[$w.ProcessId] = $true
        $p = $w.ProcessPath
        $disp = $null
        if (Test-PackagedPath $p) {
            $r = Resolve-PathPackage $p
            if ($r) {
                $p = 'shell:AppsFolder\\' + $r.Aumid
                $disp = $r.Display
            }
        }
        if (-not $disp) {
            # Classic apps: the exe's FileDescription is the human name
            # (e.g. "NZXT CAM" rather than "NZXT CAM.exe").
            try {
                $fd = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($w.ProcessPath).FileDescription
                if ($fd) { $disp = $fd.Trim() }
            } catch { }
        }
        if (-not $disp) { $disp = $w.ProcessName }
        # Some apps put a file name in their version info (e.g. "Foo.dll").
        if ($disp -match '\\.(exe|dll)$') { $disp = $disp.Substring(0, $disp.Length - 4) }
        $items.Add([pscustomobject]@{ name = $w.ProcessName; title = $w.Title; path = $p; display = $disp })
    }
    Write-Output (ConvertTo-Json -InputObject $items.ToArray() -Compress)
} catch {
    Write-Output (ConvertTo-Json -InputObject @{ ok = $false; error = $_.Exception.Message } -Compress)
}
`;
}

/**
 * Lists connected monitors with bounds and work areas (physical pixels,
 * virtual-desktop coordinates). Used by the Property Inspector's Monitor
 * dropdown.
 */
export function buildMonitorListScript(): string {
	return `
${PROLOG}
${NATIVE}
try {
    $items = @([MonitorFinder]::ListAll() | ForEach-Object {
        [pscustomobject]@{
            deviceName = $_.DeviceName
            left = $_.Left
            top = $_.Top
            width = $_.Width
            height = $_.Height
            workLeft = $_.WorkLeft
            workTop = $_.WorkTop
            workWidth = $_.WorkWidth
            workHeight = $_.WorkHeight
            isPrimary = $_.IsPrimary
        }
    })
    Write-Output (ConvertTo-Json -InputObject $items -Compress)
} catch {
    Write-Output (ConvertTo-Json -InputObject @{ ok = $false; error = $_.Exception.Message } -Compress)
}
`;
}

/**
 * Runs a script through Windows PowerShell 5.1 via a temp .ps1 file — the
 * scripts exceed the ~32K process command-line limit that -EncodedCommand is
 * subject to. UTF-8 with BOM so PS 5.1 decodes non-ASCII correctly; no console
 * window. Parses the last JSON line from stdout.
 */
export function runPowerShell<T>(script: string, timeoutMs: number): Promise<T> {
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	const psExe = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

	let scriptDir: string;
	let scriptFile: string;
	try {
		scriptDir = mkdtempSync(path.join(tmpdir(), "snap-launcher-"));
		scriptFile = path.join(scriptDir, `run-${randomBytes(6).toString("hex")}.ps1`);
		// Prepend a UTF-8 BOM: PS 5.1 assumes ANSI for BOM-less files.
		writeFileSync(scriptFile, String.fromCharCode(0xfeff) + script, "utf8");
	} catch (e) {
		return Promise.reject(new Error(`Could not write the PowerShell script to a temp file: ${e instanceof Error ? e.message : String(e)}`));
	}

	return new Promise<T>((resolve, reject) => {
		execFile(
			psExe,
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile],
			{ timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				try {
					rmSync(scriptDir, { recursive: true, force: true });
				} catch {
					// best effort; the OS temp cleaner will get it eventually
				}
				const text = (stdout ?? "").toString();
				const lines = text
					.split(/\r?\n/)
					.map((l) => l.trim())
					.filter((l) => l.length > 0);

				for (let i = lines.length - 1; i >= 0; i--) {
					const line = lines[i];
					if (line.startsWith("{") || line.startsWith("[")) {
						try {
							resolve(JSON.parse(line) as T);
							return;
						} catch {
							// keep scanning earlier lines
						}
					}
				}

				if (error) {
					reject(new Error((stderr ?? "").toString().trim() || error.message));
				} else {
					reject(new Error("PowerShell produced no parsable output." + (lines.length ? " Last line: " + lines[lines.length - 1].slice(0, 300) : "")));
				}
			},
		);
	});
}
