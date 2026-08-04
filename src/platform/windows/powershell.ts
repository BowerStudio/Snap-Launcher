import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ICON_MAX_PX } from "../types";
import type { CloseConfig, LaunchConfig, SteamTarget } from "../types";

// Shared shapes now live in ../types; re-exported so existing importers of this
// module (including the test suite) keep working unchanged.
export type {
	AppIcon,
	AppIconResult,
	CaptureResult,
	CloseConfig,
	CloseMode,
	CloseResult,
	InstalledApp,
	LaunchConfig,
	LaunchResult,
	MonitorEntry,
	PositionMode,
	RunningApp,
	SteamTarget,
} from "../types";

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

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

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
 * Virtual-desktop control via the shell's internal COM interfaces (there is
 * no documented API to enumerate, create, or switch desktops, or to move
 * another process's window between them). Interface definitions are derived
 * from MScholtes/VirtualDesktop (MIT, https://github.com/MScholtes/VirtualDesktop).
 *
 * The IIDs below are shared by all current Windows 11 builds, but 24H2
 * (build 26100+) inserted SwitchDesktopAndMoveForegroundView into the middle
 * of IVirtualDesktopManagerInternal's vtable WITHOUT changing its IID — so
 * both layouts are declared and the build number picks the right one at
 * runtime. Windows 10 uses different IIDs entirely and is rejected with a
 * clear error. Interfaces are truncated after the last slot actually called;
 * IApplicationView is a pure opaque handle (never invoked, only passed).
 *
 * Exported for tests; included in the launch script only when a virtual
 * desktop is configured, so ordinary keys skip the extra Add-Type compile.
 */
export const VDESK = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace SnapVD {

[ComImport] [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] [Guid("6D5140C1-7436-11CE-8034-00AA006009FA")]
public interface IServiceProvider10 {
    [return: MarshalAs(UnmanagedType.IUnknown)]
    object QueryService(ref Guid service, ref Guid riid);
}

[ComImport] [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] [Guid("92CA9DCD-5622-4BBA-A805-5E9F541BD8C9")]
public interface IObjectArray {
    void GetCount(out int count);
    void GetAt(int index, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object obj);
}

// Opaque handle: obtained from GetViewForHwnd, passed to MoveViewToDesktop,
// never invoked - so no methods need declaring.
[ComImport] [InterfaceType(ComInterfaceType.InterfaceIsIInspectable)] [Guid("372E1D3B-38D3-42E4-A15B-8AB2B178F513")]
public interface IApplicationView {
}

[ComImport] [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] [Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5")]
public interface IApplicationViewCollection {
    int GetViews(out IObjectArray array);
    int GetViewsByZOrder(out IObjectArray array);
    int GetViewsByAppUserModelId(string id, out IObjectArray array);
    int GetViewForHwnd(IntPtr hwnd, out IApplicationView view);
}

[ComImport] [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] [Guid("3F07F4BE-B107-441A-AF0F-39D82529072C")]
public interface IVirtualDesktop {
    bool IsViewVisible(IApplicationView view);
    Guid GetId();
    [return: MarshalAs(UnmanagedType.HString)]
    string GetName();
}

// Documented shell object: only reliable for asking which desktop a window is on.
[ComImport] [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] [Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
public interface IVirtualDesktopManager {
    bool IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow);
    Guid GetWindowDesktopId(IntPtr topLevelWindow);
    void MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
}

// Pre-24H2 Windows 11 vtable.
[ComImport] [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] [Guid("53F5CA0B-158F-4124-900C-057158060B27")]
public interface IVdmiWin11 {
    int GetCount();
    void MoveViewToDesktop(IApplicationView view, IVirtualDesktop desktop);
    bool CanViewMoveDesktops(IApplicationView view);
    IVirtualDesktop GetCurrentDesktop();
    void GetDesktops(out IObjectArray desktops);
    [PreserveSig] int GetAdjacentDesktop(IVirtualDesktop from, int direction, out IVirtualDesktop desktop);
    void SwitchDesktop(IVirtualDesktop desktop);
    IVirtualDesktop CreateDesktop();
    void MoveDesktop(IVirtualDesktop desktop, int nIndex);
    void RemoveDesktop(IVirtualDesktop desktop, IVirtualDesktop fallback);
    IVirtualDesktop FindDesktop(ref Guid desktopid);
    void GetDesktopSwitchIncludeExcludeViews(IVirtualDesktop desktop, out IObjectArray u1, out IObjectArray u2);
    void SetDesktopName(IVirtualDesktop desktop, [MarshalAs(UnmanagedType.HString)] string name);
}

// 24H2+ vtable: SwitchDesktopAndMoveForegroundView appeared after SwitchDesktop.
[ComImport] [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] [Guid("53F5CA0B-158F-4124-900C-057158060B27")]
public interface IVdmi24H2 {
    int GetCount();
    void MoveViewToDesktop(IApplicationView view, IVirtualDesktop desktop);
    bool CanViewMoveDesktops(IApplicationView view);
    IVirtualDesktop GetCurrentDesktop();
    void GetDesktops(out IObjectArray desktops);
    [PreserveSig] int GetAdjacentDesktop(IVirtualDesktop from, int direction, out IVirtualDesktop desktop);
    void SwitchDesktop(IVirtualDesktop desktop);
    void SwitchDesktopAndMoveForegroundView(IVirtualDesktop desktop);
    IVirtualDesktop CreateDesktop();
    void MoveDesktop(IVirtualDesktop desktop, int nIndex);
    void RemoveDesktop(IVirtualDesktop desktop, IVirtualDesktop fallback);
    IVirtualDesktop FindDesktop(ref Guid desktopid);
    void GetDesktopSwitchIncludeExcludeViews(IVirtualDesktop desktop, out IObjectArray u1, out IObjectArray u2);
    void SetDesktopName(IVirtualDesktop desktop, [MarshalAs(UnmanagedType.HString)] string name);
}

public static class VDesk {
    static IVdmiWin11 _old;
    static IVdmi24H2 _new;
    static IApplicationViewCollection _views;
    static IVirtualDesktopManager _mgr;
    static bool _modern;
    static bool _ready;

    // Sentinel desktop ids for windows/apps pinned to every desktop.
    static readonly Guid AppOnAllDesktops = new Guid("BB64D5B7-4DE3-4AB2-A87C-DB7601AEA7DC");
    static readonly Guid WindowOnAllDesktops = new Guid("C2DDEA68-66F2-4CF9-8264-1BFD00FBBBAC");

    public static void Init() {
        if (_ready) return;
        int build = 0;
        try {
            using (var k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey("SOFTWARE\\\\Microsoft\\\\Windows NT\\\\CurrentVersion"))
                build = int.Parse((string)k.GetValue("CurrentBuildNumber"));
        } catch { }
        if (build == 0) build = Environment.OSVersion.Version.Build;
        if (build < 22000) throw new NotSupportedException("Virtual desktop control needs Windows 11 (build 22000 or later); this is build " + build + ".");
        _modern = build >= 26100;
        var shell = (IServiceProvider10)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239")));
        Guid clsidInternal = new Guid("C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B");
        if (_modern) {
            Guid iid = typeof(IVdmi24H2).GUID;
            _new = (IVdmi24H2)shell.QueryService(ref clsidInternal, ref iid);
        } else {
            Guid iid = typeof(IVdmiWin11).GUID;
            _old = (IVdmiWin11)shell.QueryService(ref clsidInternal, ref iid);
        }
        Guid viewsIid = typeof(IApplicationViewCollection).GUID;
        _views = (IApplicationViewCollection)shell.QueryService(ref viewsIid, ref viewsIid);
        _mgr = (IVirtualDesktopManager)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A")));
        _ready = true;
    }

    public static int Count { get { return _modern ? _new.GetCount() : _old.GetCount(); } }

    static IVirtualDesktop At(int index) {
        IObjectArray arr;
        if (_modern) _new.GetDesktops(out arr); else _old.GetDesktops(out arr);
        Guid iid = typeof(IVirtualDesktop).GUID;
        object o;
        arr.GetAt(index, ref iid, out o);
        Marshal.ReleaseComObject(arr);
        return (IVirtualDesktop)o;
    }

    static string NameAt(int index) {
        string n = null;
        try { n = At(index).GetName(); } catch { }
        if (string.IsNullOrEmpty(n)) n = "Desktop " + (index + 1);
        return n;
    }

    public static List<string> List() {
        var r = new List<string>();
        int c = Count;
        for (int i = 0; i < c; i++) r.Add(NameAt(i));
        return r;
    }

    public static int CurrentIndex() {
        Guid cur = (_modern ? _new.GetCurrentDesktop() : _old.GetCurrentDesktop()).GetId();
        int c = Count;
        for (int i = 0; i < c; i++) if (At(i).GetId() == cur) return i;
        return -1;
    }

    public static int FindByName(string name) {
        name = name.Trim();
        int c = Count;
        for (int i = 0; i < c; i++) if (string.Equals(NameAt(i), name, StringComparison.OrdinalIgnoreCase)) return i;
        return -1;
    }

    public static bool LastEnsureCreated;

    // Returns the index of the desktop with this name, creating (and naming)
    // it when absent. "Desktop N" (the shell's generic naming) is positional:
    // enough unnamed desktops are created for index N to exist.
    public static int EnsureDesktop(string name) {
        LastEnsureCreated = false;
        name = name.Trim();
        int idx = FindByName(name);
        if (idx >= 0) return idx;
        var m = System.Text.RegularExpressions.Regex.Match(name, "^[Dd]esktop +([0-9]{1,2})$");
        if (m.Success) {
            int want = int.Parse(m.Groups[1].Value);
            if (want >= 1 && want <= 20) {
                while (Count < want) { Create(); LastEnsureCreated = true; }
                return want - 1;
            }
        }
        IVirtualDesktop d = Create();
        if (_modern) _new.SetDesktopName(d, name); else _old.SetDesktopName(d, name);
        LastEnsureCreated = true;
        return Count - 1;  // new desktops append at the end
    }

    static IVirtualDesktop Create() { return _modern ? _new.CreateDesktop() : _old.CreateDesktop(); }

    // Test/cleanup helper; the launcher itself never removes desktops.
    public static void RemoveAt(int index) {
        IVirtualDesktop d = At(index);
        IVirtualDesktop fallback = At(index == 0 ? 1 : 0);
        if (_modern) _new.RemoveDesktop(d, fallback); else _old.RemoveDesktop(d, fallback);
    }

    public static bool SwitchTo(int index) {
        if (CurrentIndex() == index) return false;
        IVirtualDesktop d = At(index);
        if (_modern) _new.SwitchDesktop(d); else _old.SwitchDesktop(d);
        return true;
    }

    // Moves the window's view to the desktop unless it is already there (or
    // pinned to all desktops). Works for other processes' windows, which the
    // documented MoveWindowToDesktop does not.
    public static bool EnsureWindowOn(IntPtr hwnd, int index) {
        IVirtualDesktop target = At(index);
        Guid targetId = target.GetId();
        Guid windowId = Guid.Empty;
        try { windowId = _mgr.GetWindowDesktopId(hwnd); } catch { }
        if (windowId == targetId || windowId == AppOnAllDesktops || windowId == WindowOnAllDesktops) return false;
        IApplicationView view;
        _views.GetViewForHwnd(hwnd, out view);
        if (view == null) return false;
        if (_modern) _new.MoveViewToDesktop(view, target); else _old.MoveViewToDesktop(view, target);
        return true;
    }
}
}
'@

function Initialize-VDesk {
    try {
        [SnapVD.VDesk]::Init()
    } catch {
        $inner = $_.Exception
        while ($inner.InnerException) { $inner = $inner.InnerException }
        throw ('Virtual desktop control is unavailable: ' + $inner.Message + ' Clear the Virtual desktop field to launch on the current desktop.')
    }
}
`;

/**
 * Follows a Start Menu shortcut to the executable it points at. Shared by the
 * window scripts (which need the process name) and the icon script (which needs
 * the folder), so a .lnk is resolved exactly one way throughout.
 */
const SHORTCUTS = `
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
 *
 * Steam games are matched the same way as Store apps, and for the same reason:
 * the game starts by way of steam.exe, and the exe that ends up owning the
 * window is named by the developer, not by anything the key knows. Its install
 * directory, however, is exactly the boundary of "windows belonging to this
 * game" — launchers, anti-cheat front-ends and the game itself all live inside
 * it.
 */
const FIND_WINDOW = `
${SHORTCUTS}
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

# Resolving the target runs before each script's own try block, so it carries
# one of its own: an app that cannot be identified at all must be reported as
# result JSON rather than escaping as a raw PowerShell error. The failure is
# recorded rather than acted on, because what it means depends on the caller —
# a launch cannot proceed, while a close has simply found nothing to close.
# (try/catch introduces no scope in PowerShell, so everything assigned here is
# still script-scope below.)
$resolveError = $null
try {
    $aumid = $null
    $exePath = $null
    if (-not $steam) {
        $aumid = Get-TargetAumid $cfg.appPath
        if (-not $aumid) {
            $exePath = Resolve-TargetExe $cfg.appPath
            if (Test-PackagedPath $exePath) {
                $a = Resolve-PathPackage $exePath
                if ($a) { $aumid = $a.Aumid }
            }
        }
    }

    $procName = $cfg.processName
    if ($procName -and $procName.ToLower().EndsWith('.exe')) { $procName = $procName.Substring(0, $procName.Length - 4) }

    $pkgRoot = $null
    if ($steam) {
        if ($steam.installDir) { $pkgRoot = $steam.installDir.TrimEnd('\\') + '\\' }
        if (-not $procName -and -not $pkgRoot) {
            throw ('"' + $steam.name + '" does not appear to be installed in any Steam library. Install it in Steam, or set a Process name override in the key settings.')
        }
    } elseif ($aumid) {
        $pkg = Get-PackageForAumid $aumid
        if ($pkg -and $pkg.InstallLocation) { $pkgRoot = $pkg.InstallLocation + '\\' }
        if (-not $procName -and -not $pkgRoot) {
            throw ('Could not find an installed Store package for "' + $aumid + '". Re-pick the app, or set a Process name override in the key settings.')
        }
    } elseif (-not $procName) {
        $procName = [System.IO.Path]::GetFileNameWithoutExtension($exePath)
        if (-not $procName) { throw 'Could not determine a process name from the application path.' }
    }

    $targetDesc = if ($steam) { $steam.name } elseif ($procName) { $procName } else { $aumid }
} catch {
    $resolveError = $_.Exception.Message
}
`;

/**
 * Reading the icon Windows applications actually carry: the one compiled into
 * the executable itself, as RT_GROUP_ICON and RT_ICON resources.
 *
 * Most Windows apps ship no .ico at all — Notepad, Photoshop and Acrobat all
 * keep theirs inside the .exe — so without this the file search finds nothing
 * for the majority of keys.
 *
 * The group's frames are copied back out and reassembled into a standalone .ico
 * in memory, rather than extracted with PrivateExtractIcons or
 * ExtractAssociatedIcon. Both of those hand back a single HICON at one
 * requested size, upscaling a small frame to fill it; rebuilding the container
 * keeps every frame at its authored resolution and hands the result to exactly
 * the same decoder a real .ico goes through.
 *
 * LOAD_LIBRARY_AS_DATAFILE maps the file without running a line of its code —
 * this reads an executable, it never loads one.
 *
 * Exported for tests.
 */
export const ICON_RESOURCES = `
function Initialize-IconResources {
    if ('SnapIcons.IconResources' -as [type]) { return }
    Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace SnapIcons {

public static class IconResources {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr module);

    private delegate bool EnumResNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr param);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumResNameProc callback, IntPtr param);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LockResource(IntPtr data);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SizeofResource(IntPtr module, IntPtr resource);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CreateIconFromResourceEx(byte[] bits, uint size, bool isIcon, uint version, int cx, int cy, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr icon);

    private const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;
    private const uint ICON_RESOURCE_VERSION = 0x00030000;
    private static readonly IntPtr RT_ICON = (IntPtr)3;
    private static readonly IntPtr RT_GROUP_ICON = (IntPtr)14;

    /// <summary>
    /// Decodes one icon frame - a DIB, colour plane and transparency mask
    /// together - to a bitmap at the size the frame was authored at.
    /// </summary>
    /// <remarks>
    /// System.Drawing.Icon cannot do this job. A 256-pixel frame records its
    /// dimensions as the byte 0, because the field cannot hold 256; Icon's
    /// nearest-size matching takes that at face value and hands back the next
    /// size down, so Photoshop's 256px icon arrives as 64px. Passing the frame
    /// to the API Windows uses itself, at the size the directory says it is,
    /// gets the frame that was asked for.
    /// </remarks>
    public static System.Drawing.Bitmap DecodeFrame(byte[] frame, int width, int height) {
        IntPtr icon = CreateIconFromResourceEx(frame, (uint)frame.Length, true, ICON_RESOURCE_VERSION, width, height, 0);
        if (icon == IntPtr.Zero) return null;
        try {
            // FromHandle does not take ownership, so the handle is still ours
            // to destroy; ToBitmap copies the pixels out, alpha included.
            using (System.Drawing.Icon managed = System.Drawing.Icon.FromHandle(icon)) {
                return managed.ToBitmap();
            }
        } finally {
            DestroyIcon(icon);
        }
    }

    private static byte[] ResourceBytes(IntPtr module, IntPtr type, IntPtr name) {
        IntPtr resource = FindResource(module, name, type);
        if (resource == IntPtr.Zero) return null;
        uint size = SizeofResource(module, resource);
        if (size == 0) return null;
        IntPtr handle = LoadResource(module, resource);
        if (handle == IntPtr.Zero) return null;
        IntPtr data = LockResource(handle);
        if (data == IntPtr.Zero) return null;
        byte[] bytes = new byte[size];
        Marshal.Copy(data, bytes, 0, (int)size);
        return bytes;
    }

    /// <summary>
    /// The executable's application icon, as the bytes of a standalone .ico
    /// file, or null when it carries none.
    /// </summary>
    public static byte[] Extract(string path) {
        IntPtr module = LoadLibraryEx(path, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (module == IntPtr.Zero) return null;
        try {
            // PE resource directories are stored sorted, and the first icon
            // group is the one Explorer shows - the same icon index 0 that
            // ExtractIcon would give.
            //
            // The group is read inside the callback, not after it. A resource
            // named by a string rather than an ordinal - as explorer.exe's own
            // icon is - arrives in a temporary buffer that the loader frees the
            // moment the callback returns, so a name kept for later names
            // nothing at all.
            byte[] group = null;
            EnumResourceNames(module, RT_GROUP_ICON, delegate(IntPtr m, IntPtr t, IntPtr n, IntPtr p) {
                group = ResourceBytes(m, RT_GROUP_ICON, n);
                return false;
            }, IntPtr.Zero);
            if (group == null || group.Length < 6) return null;

            int count = BitConverter.ToUInt16(group, 4);
            if (count < 1 || group.Length < 6 + (count * 14)) return null;

            // A GRPICONDIRENTRY is a 16-byte ICONDIRENTRY with the frame's
            // 4-byte file offset replaced by its 2-byte resource id, so the
            // first 12 bytes carry over untouched.
            List<byte[]> entries = new List<byte[]>();
            List<byte[]> frames = new List<byte[]>();
            int total = 0;
            for (int i = 0; i < count; i++) {
                int at = 6 + (i * 14);
                byte[] frame = ResourceBytes(module, RT_ICON, (IntPtr)BitConverter.ToUInt16(group, at + 12));
                if (frame == null || frame.Length == 0) continue;
                byte[] entry = new byte[16];
                Array.Copy(group, at, entry, 0, 12);
                // Trust the resource's real length over the recorded one.
                BitConverter.GetBytes(frame.Length).CopyTo(entry, 8);
                entries.Add(entry);
                frames.Add(frame);
                total += frame.Length;
            }
            if (entries.Count == 0) return null;

            byte[] ico = new byte[6 + (entries.Count * 16) + total];
            ico[2] = 1; // type: icon
            BitConverter.GetBytes((ushort)entries.Count).CopyTo(ico, 4);
            int offset = 6 + (entries.Count * 16);
            for (int i = 0; i < entries.Count; i++) {
                BitConverter.GetBytes(offset).CopyTo(entries[i], 12);
                entries[i].CopyTo(ico, 6 + (i * 16));
                frames[i].CopyTo(ico, offset);
                offset += frames[i].Length;
            }
            return ico;
        } finally {
            FreeLibrary(module);
        }
    }
}
}
'@
}

# The executable's own icon as .ico bytes, or $null. The leading comma stops
# PowerShell unrolling the byte array into the pipeline one byte at a time.
function Get-ExecutableIcon([string]$exe) {
    if (-not $exe) { return $null }
    try { if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $null } } catch { return $null }
    Initialize-IconResources
    $bytes = [SnapIcons.IconResources]::Extract($exe)
    if ($null -eq $bytes -or $bytes.Length -eq 0) { return $null }
    return ,$bytes
}
`;

/**
 * Finding an application's icon file on disk, and decoding it.
 *
 * A Windows app that ships an icon puts a .ico under the folder holding its
 * executable. Sometimes that is right beside it; Electron apps bury it several
 * folders down (Signal's sits at resources/app.asar.unpacked/build/icons/win),
 * so the walk goes deep, under both a depth and a result cap — the very same
 * code is pointed at a Steam game's install directory, which can hold tens of
 * thousands of files.
 *
 * A candidate must be tied to the app by name: exactly the executable's, one of
 * the conventional generic names, one that shares a prefix with it, or one that
 * shares a whole word with it (which is what connects "Warhammer 40,000:
 * Darktide" to Darktide.exe). A file with an unrelated name is never a
 * candidate, however alone it sits in the folder — System32 holds exactly one
 * .ico, OneDrive's, and a Notepad key showing the OneDrive logo is worse than a
 * Notepad key showing nothing of the sort.
 *
 * Within that, the best-related name wins, then the shallowest, then the
 * largest; ties break on name so one folder always yields the same icon.
 *
 * The same ranking serves both extensions this searches for: .ico files, and
 * the .exe files a Steam game's icon has to be read out of, since a game's
 * executable is named by its developer and known nowhere else.
 *
 * Exported for tests.
 */
export const ICON_HELPERS = `
Add-Type -AssemblyName System.Drawing

$script:GenericIconNames = @('app', 'appicon', 'application', 'icon', 'logo', 'main')

# Folders that belong to no single application. An .ico found under one of them
# says nothing about the app being looked at — pointing at C:\\Windows\\explorer.exe
# otherwise turns up some unrelated installer's AppIcon.ico several folders
# away — and walking them is slow enough to be worth avoiding on its own. An app
# living directly in one of these goes straight to its executable's own icon.
$script:SharedFolders = @(@(
    $env:SystemRoot
    if ($env:SystemRoot) { Join-Path $env:SystemRoot 'System32'; Join-Path $env:SystemRoot 'SysWOW64' }
    $env:ProgramFiles
    [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $env:ProgramData
    $env:LOCALAPPDATA
    if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs' }
    $env:APPDATA
    $env:USERPROFILE
) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\\').ToLower() })

function Test-SharedFolder([string]$folder) {
    if (-not $folder) { return $true }
    $normalized = $folder.TrimEnd('\\').ToLower()
    # A drive root trims to "c:" and is shared by definition.
    if ($normalized.Length -le 2) { return $true }
    return ($script:SharedFolders -contains $normalized)
}

# Words worth matching on: short ones ("of", "the", "2") connect nothing.
function Get-NameWords([string]$name) {
    if (-not $name) { return @() }
    return @([System.Text.RegularExpressions.Regex]::Split($name.ToLower(), '[^a-z0-9]+') | Where-Object { $_.Length -ge 4 })
}

function Get-IconCandidates([string]$root, [string]$appName, [string]$filter) {
    if (-not $root) { return @() }
    try { if (-not (Test-Path -LiteralPath $root -PathType Container)) { return @() } } catch { return @() }

    # -Depth bounds how far the walk goes and -First bounds what it collects:
    # between them, an install directory of any size costs a bounded amount.
    $files = @(Get-ChildItem -LiteralPath $root -Filter $filter -File -Recurse -Depth 6 -Force -ErrorAction SilentlyContinue |
        Select-Object -First 200)
    if ($files.Count -eq 0) { return @() }

    $rootLength = $root.TrimEnd('\\').Length + 1
    $wanted = ''
    if ($appName) { $wanted = $appName.ToLower() }
    $words = Get-NameWords $appName

    $ranked = @($files | ForEach-Object {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($_.Name).ToLower()
        $rank = -1
        if ($wanted -and $base -eq $wanted) { $rank = 0 }
        elseif ($script:GenericIconNames -contains $base) { $rank = 1 }
        elseif ($wanted.Length -ge 3 -and $base.Length -ge 3 -and ($base.StartsWith($wanted) -or $wanted.StartsWith($base))) { $rank = 2 }
        elseif ($words -contains $base) { $rank = 3 }
        # An unrelated name is not a candidate at all.
        if ($rank -lt 0) { return }
        [pscustomobject]@{
            Path = $_.FullName
            Rank = $rank
            Depth = $_.FullName.Substring($rootLength).Split('\\').Length
            Size = $_.Length
            Name = $_.Name
        }
    })
    return @($ranked | Sort-Object Rank, Depth, @{ Expression = 'Size'; Descending = $true }, Name | ForEach-Object { $_.Path })
}

# Appends candidates from whatever Get-IconCandidates returned, recording where
# each one's icon must be read from. Written as a loop rather than AddRange
# because PowerShell unrolls a returned empty array into $null, and
# AddRange($null) throws where "nothing to add" is the ordinary case.
#
# The limit matters: the executable's own icon is appended after these, and it
# has to stay within the number of candidates actually tried.
#
# $rawImage marks a bare image file (a Store app-list asset) that must skip
# .ico container parsing entirely; every non-Store caller omits it and gets
# the default $false.
function Add-IconCandidates($list, $paths, [bool]$fromExe, [int]$limit, [bool]$rawImage) {
    $added = 0
    foreach ($p in @($paths)) {
        if (-not $p) { continue }
        $list.Add([pscustomobject]@{ Path = [string]$p; FromExe = $fromExe; RawImage = $rawImage })
        $added++
        if ($added -ge $limit) { break }
    }
}

# A Start Menu shortcut usually names the app's icon outright ("...\\app.ico,0"),
# which beats deducing one from the folder: it is the icon Windows itself shows
# for the app, chosen by whoever packaged it. The target may be an .ico, or an
# .exe/.dll carrying the icon in its resources - the latter only at index 0,
# because any other index names a group this has no way to pick out.
function Get-ShortcutIcon([string]$lnk) {
    if (-not $lnk -or -not $lnk.ToLower().EndsWith('.lnk')) { return $null }
    $location = $null
    try {
        $sh = New-Object -ComObject WScript.Shell
        $location = [string]$sh.CreateShortcut($lnk).IconLocation
    } catch { return $null }
    if (-not $location) { return $null }

    $index = 0
    $comma = $location.LastIndexOf(',')
    if ($comma -gt 0) {
        [void][int]::TryParse($location.Substring($comma + 1).Trim(), [ref]$index)
        $location = $location.Substring(0, $comma)
    }
    $location = [Environment]::ExpandEnvironmentVariables($location.Trim().Trim('"'))
    if (-not $location) { return $null }
    try { if (-not (Test-Path -LiteralPath $location -PathType Leaf)) { return $null } } catch { return $null }

    $lower = $location.ToLower()
    if ($lower.EndsWith('.ico')) { return [pscustomobject]@{ Path = $location; FromExe = $false } }
    if ($index -eq 0 -and ($lower.EndsWith('.exe') -or $lower.EndsWith('.dll'))) {
        return [pscustomobject]@{ Path = $location; FromExe = $true }
    }
    return $null
}

# One candidate's .ico bytes, whether that is the file itself or the icon
# resources compiled into an executable. $null when it carries no icon at all.
# The leading comma stops PowerShell unrolling the array into the pipeline.
function Get-CandidateIcon($candidate) {
    $bytes = $null
    if ($candidate.FromExe) {
        $bytes = Get-ExecutableIcon $candidate.Path
    } else {
        $bytes = [System.IO.File]::ReadAllBytes($candidate.Path)
    }
    if ($null -eq $bytes -or $bytes.Length -eq 0) { return $null }
    return ,$bytes
}

# An .ico is a container: a 6-byte header, one 16-byte directory entry per
# frame, then the frames. A frame is a DIB, or - for the large sizes Vista
# introduced - an entire PNG file embedded verbatim. The biggest frame is
# picked, breaking ties on colour depth; a malformed entry is skipped rather
# than trusted, since the offsets it carries are used to index the file.
function Select-IconFrame([byte[]]$bytes) {
    if ($bytes.Length -lt 22) { return $null }
    if ($bytes[0] -ne 0 -or $bytes[1] -ne 0 -or $bytes[2] -ne 1 -or $bytes[3] -ne 0) { return $null }

    $count = [int][BitConverter]::ToUInt16($bytes, 4)
    $best = $null
    for ($i = 0; $i -lt $count; $i++) {
        $entry = 6 + ($i * 16)
        if (($entry + 16) -gt $bytes.Length) { break }

        # A zero dimension means 256: the field is one byte and cannot hold it.
        $w = [int]$bytes[$entry]; if ($w -eq 0) { $w = 256 }
        $h = [int]$bytes[$entry + 1]; if ($h -eq 0) { $h = 256 }
        $bits = [int][BitConverter]::ToUInt16($bytes, $entry + 6)
        $length = [long][BitConverter]::ToUInt32($bytes, $entry + 8)
        $offset = [long][BitConverter]::ToUInt32($bytes, $entry + 12)
        if ($length -le 0 -or $offset -lt 22 -or ($offset + $length) -gt $bytes.Length) { continue }

        $area = $w * $h
        if ($best -and ($area -lt $best.Area -or ($area -eq $best.Area -and $bits -le $best.Bits))) { continue }
        $best = [pscustomobject]@{
            Width = $w
            Height = $h
            Bits = $bits
            Area = $area
            Offset = [int]$offset
            Length = [int]$length
            IsPng = ($length -gt 8 -and $bytes[$offset] -eq 0x89 -and $bytes[$offset + 1] -eq 0x50 -and $bytes[$offset + 2] -eq 0x4E -and $bytes[$offset + 3] -eq 0x47)
        }
    }
    return $best
}

# Downscales a decoded System.Drawing image onto a 32bpp ARGB transparent
# canvas so an icon's rounded edges (or a Store asset's plated background)
# stay transparent on the key, and returns it as a base64 PNG. Shared by
# ConvertTo-IconPng and ConvertTo-ScaledImagePng, which differ only in how
# $source is decoded in the first place. Width/Height are the source's own
# dimensions, before the downscale — callers show that as the icon's size.
function Get-ScaledPng($source, [int]$maxPx) {
    $canvas = $null
    $graphics = $null
    $output = $null
    try {
        $width = $source.Width
        $height = $source.Height
        $scale = 1.0
        if ($width -gt $maxPx -or $height -gt $maxPx) { $scale = [Math]::Min($maxPx / $width, $maxPx / $height) }
        $targetWidth = [Math]::Max(1, [int][Math]::Round($width * $scale))
        $targetHeight = [Math]::Max(1, [int][Math]::Round($height * $scale))

        $canvas = New-Object System.Drawing.Bitmap -ArgumentList $targetWidth, $targetHeight, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($canvas)
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.DrawImage($source, 0, 0, $targetWidth, $targetHeight)

        $output = New-Object System.IO.MemoryStream
        $canvas.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
        return [pscustomobject]@{ Base64 = [Convert]::ToBase64String($output.ToArray()); Width = $width; Height = $height }
    } finally {
        if ($graphics) { $graphics.Dispose() }
        if ($canvas) { $canvas.Dispose() }
        if ($output) { $output.Dispose() }
    }
}

# Renders one .ico frame to a PNG, downscaled to fit $maxPx. A PNG-compressed
# frame already is a PNG file and is decoded as one; a DIB frame goes through
# System.Drawing.Icon, which recombines its colour plane and transparency mask
# the way Windows does.
#
# Works from bytes rather than a path, because an icon read out of an
# executable's resources never had a file of its own.
function ConvertTo-IconPng([byte[]]$bytes, $frame, [int]$maxPx) {
    $source = $null
    $frameStream = $null
    try {
        if ($frame.IsPng) {
            $frameStream = New-Object System.IO.MemoryStream
            $frameStream.Write($bytes, $frame.Offset, $frame.Length)
            $frameStream.Position = 0
            $source = [System.Drawing.Image]::FromStream($frameStream)
        } else {
            Initialize-IconResources
            [byte[]]$frameBytes = New-Object byte[] $frame.Length
            [Array]::Copy($bytes, $frame.Offset, $frameBytes, 0, $frame.Length)
            $source = [SnapIcons.IconResources]::DecodeFrame($frameBytes, $frame.Width, $frame.Height)
            if ($null -eq $source) { throw 'The icon frame could not be decoded.' }
        }
        return (Get-ScaledPng $source $maxPx)
    } finally {
        if ($source) { $source.Dispose() }
        if ($frameStream) { $frameStream.Dispose() }
    }
}

# Decodes a bare image file (a Store app's app-list PNG; never an .ico
# container) and downscales it the same way ConvertTo-IconPng does. Returns
# $null rather than throwing when the file is missing or unreadable, so the
# candidate loop can pass over it like any other failed candidate.
function ConvertTo-ScaledImagePng([string]$path, [int]$maxPx) {
    $stream = $null
    $source = $null
    try {
        $bytes = [System.IO.File]::ReadAllBytes($path)
        if ($null -eq $bytes -or $bytes.Length -eq 0) { return $null }
        $stream = New-Object System.IO.MemoryStream
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Position = 0
        $source = [System.Drawing.Image]::FromStream($stream)
        return (Get-ScaledPng $source $maxPx)
    } catch {
        return $null
    } finally {
        if ($source) { $source.Dispose() }
        if ($stream) { $stream.Dispose() }
    }
}

# A package manifest names its app-list artwork by a logical path
# (VisualElements.Square44x44Logo, e.g. "Assets\\App.png") that never exists on
# disk verbatim: MakePri writes qualifier-suffixed siblings instead
# ("App.targetsize-256_altform-unplated.png", "App.scale-200.png", ...), and
# the shell picks one at render time. This ranks every sibling and returns
# them best first, so a caller can queue more than one and let a file that
# fails to decode fall through to the next rather than costing the whole
# lookup: the largest unplated targetsize (a transparent glyph, matching every
# other icon this plugin shows), then the largest plated targetsize, then the
# largest scale variant, then the unqualified name if it happens to exist.
#
# High-contrast and light-theme qualifiers are excluded outright — matched by
# substring so their order in the filename never matters. "contrast-standard"
# is deliberately NOT among them: in MakePri's qualifier vocabulary "standard"
# is the ordinary asset and "black"/"white" are the high-contrast ones, so
# excluding it would discard correct artwork from a package that ships only
# contrast-qualified variants. A blacklist is also
# not the whole fix: File Explorer ships a "_contrast-black" sibling at the
# exact same rank and size as its correct "_devicefamily-colorfulunplated"
# counterpart, and which one wins a tie must not depend on Get-ChildItem's
# filesystem-order luck. Among equal rank and size, the candidate with fewer
# underscore-separated qualifier segments — the plainer filename — wins; that
# also survives a qualifier nobody has seen yet, which a blacklist by
# construction cannot. Anything still tied breaks on ordinal name so the
# result is deterministic.
#
# $logicalPath is third-party input straight out of an AppxManifest.xml this
# plugin does not control. Join-Path tolerates any character, but .NET
# Framework's System.IO.Path helpers throw ArgumentException on one like "|"
# that Join-Path let through uncomplained, so every one of them is guarded:
# a malformed path is an empty result, never an exception that would turn an
# ordinary miss into ok:false.
$script:LogoQualifierBlacklist = @('altform-lightunplated', 'contrast-black', 'contrast-white', 'theme-light')
$script:LogoImageExtensions = @('.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.tif')

function Get-LogoAssetCandidates([string]$installLocation, [string]$logicalPath) {
    if (-not $installLocation -or -not $logicalPath) { return @() }

    $dir = $null
    $base = $null
    $exact = $null
    try {
        $full = Join-Path $installLocation $logicalPath
        $dir = [System.IO.Path]::GetDirectoryName($full)
        $base = [System.IO.Path]::GetFileNameWithoutExtension($full)
        $exact = [System.IO.Path]::GetFileName($full)
    } catch { return @() }
    if (-not $dir -or -not $base) { return @() }
    try { if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return @() } } catch { return @() }

    $files = @(Get-ChildItem -LiteralPath $dir -Filter ($base + '.*') -File -ErrorAction SilentlyContinue)
    if ($files.Count -eq 0) { return @() }

    $ranked = @($files | ForEach-Object {
        if ($script:LogoImageExtensions -notcontains $_.Extension.ToLower()) { return }
        $lower = $_.Name.ToLower()
        foreach ($bad in $script:LogoQualifierBlacklist) { if ($lower.Contains($bad)) { return } }

        $rank = -1
        $size = 0
        $m = [System.Text.RegularExpressions.Regex]::Match($lower, 'targetsize-(\\d+)')
        if ($m.Success) {
            $size = [int]$m.Groups[1].Value
            if ($lower.Contains('altform-unplated')) { $rank = 3 } else { $rank = 2 }
        } else {
            $m = [System.Text.RegularExpressions.Regex]::Match($lower, 'scale-(\\d+)')
            if ($m.Success) {
                $size = [int]$m.Groups[1].Value
                $rank = 1
            } elseif ($_.Name -eq $exact) {
                $rank = 0
                $size = 0
            }
        }
        if ($rank -lt 0) { return }

        # Every underscore past the base name is one more qualifier segment
        # ("_altform-unplated", "_devicefamily-colorfulunplated", ...); fewer
        # of them is the plainer, more broadly-applicable asset.
        $qualifiers = ([System.IO.Path]::GetFileNameWithoutExtension($_.Name).Split('_')).Length

        [pscustomobject]@{
            Path = $_.FullName
            Name = $_.Name
            Rank = $rank
            Size = $size
            Qualifiers = $qualifiers
        }
    })
    if ($ranked.Count -eq 0) { return @() }

    return @($ranked |
        Sort-Object @{ Expression = 'Rank'; Descending = $true }, @{ Expression = 'Size'; Descending = $true }, Qualifiers, Name |
        ForEach-Object { $_.Path })
}
`;

/**
 * Finds the icon a key's application carries and returns it as base64 PNG.
 *
 * Every place worth looking is collected first, best candidate to worst, and
 * then tried in turn: the icon named by the app's own Start Menu shortcut, a
 * .ico shipped under the folder holding the executable, and finally the icon
 * compiled into the executable itself. The last of those is what answers for
 * most Windows apps, which ship no icon file at all.
 *
 * Finding nothing is reported as ok/found:false with a reason the Property
 * Inspector can show, not as an error: the key simply keeps the action's own
 * image.
 */
export function buildAppIconScript(appPath: string, steam?: SteamTarget | null): string {
	return `
${PROLOG}
$appPath = ${psJson(appPath)}
$steam = ${steam ? psJson(steam) : "$null"}
${APPX}
${SHORTCUTS}
${ICON_RESOURCES}
${ICON_HELPERS}

try {
    $candidates = New-Object System.Collections.Generic.List[object]
    $reason = $null

    if ($steam) {
        # A game's executable name is the developer's choice and is recorded
        # nowhere Snap Launcher can read, so its install directory is the whole
        # search: first any icon file in it, then the icon compiled into
        # whichever of its executables the game's name ties it to.
        if ($steam.installDir) {
            Add-IconCandidates $candidates (Get-IconCandidates $steam.installDir ([string]$steam.name) '*.ico') $false 5
            Add-IconCandidates $candidates (Get-IconCandidates $steam.installDir ([string]$steam.name) '*.exe') $true 3
            if ($candidates.Count -eq 0) { $reason = 'No icon matching "' + $steam.name + '" was found in its install folder.' }
        } else {
            $reason = '"' + $steam.name + '" is not installed in any Steam library.'
        }
    } elseif ($aumid = Get-TargetAumid $appPath) {
        # Store apps are addressed by AppUserModelId, so there is no executable
        # to read; their app-list artwork is a bare PNG named by the package
        # manifest's VisualElements, read straight off disk instead.
        $pkg = Get-PackageForAumid $aumid
        if (-not $pkg -or -not $pkg.InstallLocation) {
            $reason = 'No installed package could be found for "' + $aumid + '".'
        } else {
            $bang = $aumid.IndexOf('!')
            $appId = $aumid.Substring($bang + 1)
            $apps = Get-PackageApplications $pkg
            $app = $apps | Where-Object { $_.Id -eq $appId } | Select-Object -First 1
            if (-not $app) { $app = $apps | Select-Object -First 1 }

            $sq44 = $null
            $sq150 = $null
            if ($app -and $app.VisualElements) {
                $sq44 = [string]$app.VisualElements.Square44x44Logo
                $sq150 = [string]$app.VisualElements.Square150x150Logo
            }

            if (-not $sq44 -and -not $sq150) {
                $reason = 'The manifest for "' + $aumid + '" names no Square44x44Logo or Square150x150Logo artwork.'
            } else {
                # Square44x44Logo is the app-list glyph shown everywhere Windows
                # lists installed apps. Several of its ranked variants are
                # queued, not just the top one, so a variant that fails to
                # decode (a truncated file, say) falls through to the next
                # rather than costing the whole lookup; Square150x150Logo (the
                # Start tile) is queued last of all, the fallback for when none
                # of those decode either.
                Add-IconCandidates $candidates (Get-LogoAssetCandidates $pkg.InstallLocation $sq44) $false 3 $true
                Add-IconCandidates $candidates (Get-LogoAssetCandidates $pkg.InstallLocation $sq150) $false 1 $true
                if ($candidates.Count -eq 0) {
                    $reason = 'No Square44x44Logo or Square150x150Logo asset was found on disk for "' + $aumid + '".'
                }
            }
        }
    } else {
        # A Start Menu shortcut's own icon comes first: whoever packaged the app
        # chose it, so it beats anything deduced from the folder.
        $shortcutIcon = Get-ShortcutIcon $appPath
        if ($shortcutIcon) { $candidates.Add($shortcutIcon) }

        $exe = Resolve-TargetExe $appPath
        $folder = $null
        if ($exe) { try { $folder = [System.IO.Path]::GetDirectoryName($exe) } catch { } }
        if ($folder -and -not (Test-SharedFolder $folder)) {
            Add-IconCandidates $candidates (Get-IconCandidates $folder ([System.IO.Path]::GetFileNameWithoutExtension($exe)) '*.ico') $false 5
        }
        # Last, and most often the one that answers: the icon compiled into the
        # executable. An authored .ico beside it is the better image when there
        # is one, which is why this comes after the search rather than instead.
        if ($exe) { $candidates.Add([pscustomobject]@{ Path = $exe; FromExe = $true }) }
        if ($candidates.Count -eq 0) { $reason = 'Could not work out where this application lives on disk.' }
    }

    # The first candidate that actually decodes wins. Carrying the .ico
    # extension is no guarantee of being an icon — Acrobat's Start Menu shortcut
    # points at an "_SC_Acrobat.ico" that is really a DLL — so a candidate that
    # fails to decode is passed over rather than failing the whole lookup.
    $failure = $null
    foreach ($candidate in @($candidates | Select-Object -First 9)) {
        try {
            $png = $null
            if ($candidate.RawImage) {
                # A Store asset is a bare PNG, not an .ico container, so it skips
                # Get-CandidateIcon/Select-IconFrame entirely.
                $png = ConvertTo-ScaledImagePng $candidate.Path ${ICON_MAX_PX}
                if (-not $png) { $failure = '"' + $candidate.Path + '" is not a readable image file.' }
            } else {
                $bytes = Get-CandidateIcon $candidate
                if ($null -eq $bytes) {
                    $failure = '"' + $candidate.Path + '" carries no icon of its own.'
                } else {
                    $frame = Select-IconFrame $bytes
                    if (-not $frame) {
                        $failure = '"' + $candidate.Path + '" is not a readable icon file.'
                    } else {
                        $png = ConvertTo-IconPng $bytes $frame ${ICON_MAX_PX}
                    }
                }
            }
            if (-not $png) { continue }
            $out = @{ ok = $true; found = $true; path = $candidate.Path; width = $png.Width; height = $png.Height; png = $png.Base64 }
            Write-Output (ConvertTo-Json -InputObject $out -Compress)
            exit 0
        } catch {
            $failure = $_.Exception.Message
        }
    }

    # Each failure message already names the file it is about and reads as a
    # whole sentence, so the last one stands as the reason on its own.
    if (-not $reason) {
        if ($failure) { $reason = $failure } else { $reason = 'No icon could be found for this app.' }
    }
    Write-Output (ConvertTo-Json -InputObject @{ ok = $true; found = $false; reason = $reason } -Compress)
} catch {
    Write-Output (ConvertTo-Json -InputObject @{ ok = $false; error = $_.Exception.Message } -Compress)
}
`;
}

/** Embeds a value as a single-quoted JSON literal ('' escapes quotes). */
function psJson(value: unknown): string {
	return "ConvertFrom-Json '" + JSON.stringify(value).replace(/'/g, "''") + "'";
}

/**
 * Embeds the config, plus the resolved Steam target when the key launches a
 * game. $steam is always defined — as $null for an ordinary key — so the
 * scripts can branch on it without checking whether the variable exists.
 */
function psConfig(config: LaunchConfig | CloseConfig, steam?: SteamTarget | null): string {
	return `$cfg = ${psJson(config)}\n$steam = ${steam ? psJson(steam) : "$null"}\n`;
}

/**
 * Launches (or focuses) the configured application, waits for its window, then
 * restores + repositions it. Emits exactly one JSON line on stdout.
 */
export function buildLaunchScript(config: LaunchConfig, steam?: SteamTarget | null): string {
	return `
${PROLOG}
${psConfig(config, steam)}
${NATIVE}
${APPX}
${ZONE_HELPERS}
${config.virtualDesktop ? VDESK : ""}
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
    if ($resolveError) { throw $resolveError }

    $target = $null
    $needLaunch = $true
    $movedDesktop = $false

    # Resolve (or create) the virtual desktop and switch to it up front, so a
    # freshly launched window opens directly on the target desktop.
    $vdIndex = -1
    if ($cfg.virtualDesktop) {
        Initialize-VDesk
        $vdIndex = [SnapVD.VDesk]::EnsureDesktop([string]$cfg.virtualDesktop)
        if ([SnapVD.VDesk]::SwitchTo($vdIndex)) { Start-Sleep -Milliseconds 350 }
    }

    if ($cfg.focusIfRunning) {
        $target = Find-TargetWindow $cfg.titleFilter @()
        if ($target) { $needLaunch = $false }
    }

    if ($needLaunch) {
        $before = @(Get-CandidateWindows | ForEach-Object { $_.Handle.ToInt64() })

        if ($steam) {
            # Handed to Steam as a URL, so the client starts first if it has to
            # and the game gets its configured launch options.
            $sp = @{ FilePath = $steam.launchUrl }
        } elseif ($aumid) {
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

        # A game can spend minutes in Steam's bootstrap, shader compilation and
        # anti-cheat checks before it ever shows a window. When the key has
        # nothing to do with that window, there is nothing to wait for: report
        # the launch and let the game come up in its own time, rather than
        # failing the press on a timeout that meant nothing.
        if ($steam -and $cfg.positionMode -eq 'none' -and -not $cfg.virtualDesktop) {
            $out = @{ ok = $true; launched = $true; positioned = $false; movedDesktop = $false; pid = 0; title = $steam.name }
            Write-Output (ConvertTo-Json -InputObject $out -Compress)
            exit 0
        }

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

    # An already-running window may live on another desktop - bring it over.
    if ($vdIndex -ge 0) {
        $movedDesktop = [SnapVD.VDesk]::EnsureWindowOn($hwnd, $vdIndex)
        if ($movedDesktop) { Start-Sleep -Milliseconds 120 }
    }

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

    $out = @{ ok = $true; launched = $needLaunch; positioned = $applied; movedDesktop = $movedDesktop; pid = $target.Id; title = $target.MainWindowTitle }
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
export function buildCaptureScript(config: LaunchConfig, steam?: SteamTarget | null): string {
	return `
${PROLOG}
${psConfig(config, steam)}
${NATIVE}
${APPX}
${FIND_WINDOW}

try {
    if ($resolveError) { throw $resolveError }

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
 * Closes the configured app's windows. Graceful mode posts WM_CLOSE to every
 * matching window — identical to clicking the window's X, so apps can prompt
 * to save. closeThenKill waits out a grace period and force-quits whatever is
 * left; kill skips straight to Stop-Process. Matching (including the
 * title-filter and process-name overrides, and Store-app package matching)
 * is the same FIND_WINDOW logic the launcher uses. Finding nothing to close
 * is success, not an error — the action is idempotent.
 */
export function buildCloseScript(config: CloseConfig, steam?: SteamTarget | null): string {
	return `
${PROLOG}
${psConfig(config, steam)}
${NATIVE}
${APPX}
${FIND_WINDOW}

function Get-MatchingWindows {
    $wins = Get-CandidateWindows
    if ($cfg.titleFilter) {
        $pattern = '*' + [System.Management.Automation.WildcardPattern]::Escape($cfg.titleFilter) + '*'
        $wins = @($wins | Where-Object { $_.Title -like $pattern })
    }
    return @($wins)
}

try {
    if ($resolveError) {
        # An app that cannot be identified — an uninstalled Store package or
        # Steam game — has nothing running to close, which is this action's
        # definition of success.
        Write-Output (ConvertTo-Json -InputObject @{ ok = $true; found = 0; closed = 0; killed = 0 } -Compress)
        exit 0
    }

    $wins = Get-MatchingWindows
    $found = $wins.Count
    $closed = 0
    $killed = 0

    if ($found -gt 0) {
        if ($cfg.closeMode -eq 'kill') {
            foreach ($p in @($wins | ForEach-Object { $_.ProcessId } | Select-Object -Unique)) {
                try { Stop-Process -Id $p -Force -ErrorAction Stop; $killed++ } catch { }
            }
        } else {
            # WM_CLOSE (0x0010) to each matching top-level window. For Store
            # apps this is the ApplicationFrameHost frame, which closes the
            # hosted app exactly like its X button.
            foreach ($w in $wins) {
                if ([Native]::PostMessage($w.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { $closed++ }
            }

            if ($cfg.closeMode -eq 'closeThenKill') {
                $deadline = (Get-Date).AddSeconds([Math]::Max(1, [int]$cfg.waitSeconds))
                while ((Get-Date) -lt $deadline) {
                    if ((Get-MatchingWindows).Count -eq 0) { break }
                    Start-Sleep -Milliseconds 250
                }
                # Kill by the pids that own whatever windows survived - never
                # the pids from before the close, which may have exited and
                # been reused.
                foreach ($p in @(Get-MatchingWindows | ForEach-Object { $_.ProcessId } | Select-Object -Unique)) {
                    try { Stop-Process -Id $p -Force -ErrorAction Stop; $killed++ } catch { }
                }
            }
        }
    }

    $out = @{ ok = $true; found = $found; closed = $closed; killed = $killed }
    Write-Output (ConvertTo-Json -InputObject $out -Compress)
} catch {
    $out = @{ ok = $false; error = $_.Exception.Message }
    Write-Output (ConvertTo-Json -InputObject $out -Compress)
}
`;
}

/**
 * Lists installed applications for the "Installed apps" dropdown. Two sources:
 *
 * - Start Menu shortcuts (all-users and per-user) whose target is an .exe —
 *   the value is the .lnk path itself, which the launch script already knows
 *   how to resolve and launch.
 * - Store (MSIX/UWP) apps from the shell's AppsFolder, kept only when their
 *   parsing name is a real AppUserModelId (FamilyName!AppId) — the value is
 *   the same shell:AppsFolder\<AUMID> form the Running-apps list produces.
 *
 * Classic apps are deduplicated by resolved target exe so an app with both an
 * all-users and a per-user shortcut appears once.
 */
export function buildInstalledListScript(): string {
	return `
${PROLOG}
try {
    $items = New-Object System.Collections.Generic.List[object]
    $seen = @{}

    $sh = New-Object -ComObject WScript.Shell
    $roots = @(
        (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'),
        (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs')
    )
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($lnk in @(Get-ChildItem -LiteralPath $root -Recurse -Filter *.lnk -ErrorAction SilentlyContinue)) {
            $target = $null
            try { $target = $sh.CreateShortcut($lnk.FullName).TargetPath } catch { }
            if (-not $target -or -not $target.ToLower().EndsWith('.exe')) { continue }
            $name = [System.IO.Path]::GetFileNameWithoutExtension($lnk.Name)
            # Start Menu folders are full of "Uninstall Foo" shortcuts; a
            # launcher has no business offering those.
            if ($name -match '^uninstall\\b') { continue }
            $key = $target.ToLower()
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            $items.Add([pscustomobject]@{ name = $name; path = $lnk.FullName })
        }
    }

    $appsFolder = (New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder')
    if ($appsFolder) {
        foreach ($item in @($appsFolder.Items())) {
            $aumid = [string]$item.Path
            # Entries without '!' are classic apps (already covered by their
            # Start Menu shortcut) or shell verbs - skip them.
            if (-not $aumid -or -not $aumid.Contains('!')) { continue }
            $path = 'shell:AppsFolder\\' + $aumid
            $key = $path.ToLower()
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            $items.Add([pscustomobject]@{ name = [string]$item.Name; path = $path })
        }
    }

    $sorted = @($items | Sort-Object -Property name)
    Write-Output (ConvertTo-Json -InputObject $sorted -Compress)
} catch {
    Write-Output (ConvertTo-Json -InputObject @{ ok = $false; error = $_.Exception.Message } -Compress)
}
`;
}

/**
 * Finds where Steam is installed, which is the one part of Steam discovery that
 * isn't just reading files: the client records its own location in the
 * registry, and a user is free to install it anywhere. HKCU is written by the
 * running client and is the more current of the two; the WOW6432Node key is the
 * installer's and covers a machine where the client has never been started.
 *
 * Absent keys are not an error — a machine without Steam simply reports no
 * path, and the caller falls back to the default install locations.
 */
export function buildSteamPathScript(): string {
	return `
${PROLOG}
try {
    $paths = New-Object System.Collections.Generic.List[string]
    foreach ($k in @(
        @{ Path = 'HKCU:\\Software\\Valve\\Steam'; Name = 'SteamPath' },
        @{ Path = 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam'; Name = 'InstallPath' },
        @{ Path = 'HKLM:\\SOFTWARE\\Valve\\Steam'; Name = 'InstallPath' }
    )) {
        try {
            $v = (Get-ItemProperty -LiteralPath $k.Path -Name $k.Name -ErrorAction Stop).$($k.Name)
            if ($v) { $paths.Add([string]$v) }
        } catch { }
    }
    Write-Output (ConvertTo-Json -InputObject @{ ok = $true; paths = $paths.ToArray() } -Compress)
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
		return Promise.reject(
			new Error(
				`Could not write the PowerShell script to a temp file: ${e instanceof Error ? e.message : String(e)}`,
			),
		);
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
					reject(
						new Error(
							"PowerShell produced no parsable output." +
								(lines.length ? " Last line: " + lines[lines.length - 1].slice(0, 300) : ""),
						),
					);
				}
			},
		);
	});
}
