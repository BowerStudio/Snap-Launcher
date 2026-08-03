import { ICON_MAX_PX, type SteamTarget } from "../types";
import { APP_HELPERS } from "./apps";
import { jsLiteral, wrapScript } from "./scripts";

/**
 * Finding an application's icon on macOS.
 *
 * This is the counterpart of the Windows .ico search, and it has an easier job:
 * every .app bundle keeps its icon in one known place. Info.plist's
 * CFBundleIconFile names it, and it lives in Contents/Resources — so there is a
 * folder to search only when that key is missing.
 *
 * Conversion is handed to /usr/bin/sips rather than done through AppKit. sips
 * reads .icns natively, picks the largest representation, scales, and writes a
 * PNG in one call, which is both less code and less bridging surface than
 * compositing an NSBitmapImageRep by hand. It ships with macOS, so there is
 * nothing to depend on.
 *
 * Requires no permission of any kind: this is reading files the user can
 * already read.
 */
export function buildAppIconScript(appPath: string, steam?: SteamTarget | null): string {
	return wrapScript(
		`
        var IDENTITY = ${jsLiteral(appPath)};
        var MAX_PX = ${ICON_MAX_PX};
        var fm = $.NSFileManager.defaultManager;

        function names(dir) {
            var contents = fm.contentsOfDirectoryAtPathError(dir, $());
            if (!contents || contents.isNil()) return [];
            // ObjC.unwrap on an NSArray is shallow, so each element has to be
            // unwrapped in its own right - see buildInstalledListScript.
            return ObjC.unwrap(contents).map(function (e) { return ObjC.unwrap(e); });
        }

        /**
         * The bundle whose icon a key should show. A Steam game's bundle
         * identifier is the developer's business and is recorded nowhere Snap
         * Launcher can read, so the game is found the same way its windows are:
         * by what Steam installed into its own directory.
         */
        function targetBundle() {
            if (STEAM) {
                if (!STEAM.installDir) return null;
                if (/\\.app$/i.test(STEAM.installDir)) return STEAM.installDir;
                var entries = names(STEAM.installDir).sort();
                for (var i = 0; i < entries.length; i++) {
                    if (/\\.app$/i.test(entries[i])) return STEAM.installDir + '/' + entries[i];
                }
                return null;
            }
            return resolveBundlePath(IDENTITY);
        }

        /**
         * The bundle's .icns. CFBundleIconFile is authoritative and may omit
         * the extension; without it, any .icns in Resources is the same guess
         * the Windows side makes when it finds a stray .ico beside an exe.
         *
         * Apps that moved their icon into an asset catalog have neither, and
         * are reported as having no icon rather than guessed at.
         */
        function iconFileFor(bundlePath) {
            var resources = bundlePath + '/Contents/Resources';
            var plist = $.NSDictionary.dictionaryWithContentsOfFile(bundlePath + '/Contents/Info.plist');
            if (plist && !plist.isNil()) {
                var value = plist.objectForKey('CFBundleIconFile');
                if (value && !value.isNil()) {
                    var named = String(ObjC.unwrap(value));
                    if (named.length) {
                        if (!/\\.icns$/i.test(named)) named = named + '.icns';
                        var declared = resources + '/' + named;
                        if (fm.fileExistsAtPath(declared)) return declared;
                    }
                }
            }
            var entries = names(resources).sort();
            for (var i = 0; i < entries.length; i++) {
                if (/\\.icns$/i.test(entries[i])) return resources + '/' + entries[i];
            }
            return null;
        }

        /** Renders an .icns to a PNG data blob, via a temp file sips can write. */
        function renderPng(iconPath) {
            var tmp = ObjC.unwrap($.NSTemporaryDirectory()) + 'snap-launcher-icon-' + Date.now() + '.png';
            try {
                // --resampleHeightWidthMax caps the long edge; sips reads the
                // largest representation in the .icns of its own accord.
                var status = runTool('/usr/bin/sips', [
                    '-s', 'format', 'png',
                    '--resampleHeightWidthMax', String(MAX_PX),
                    iconPath, '--out', tmp
                ]);
                if (Number(status) !== 0) return null;
                var data = $.NSData.dataWithContentsOfFile(tmp);
                if (!data || data.isNil() || Number(data.length) === 0) return null;
                return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
            } finally {
                fm.removeItemAtPathError(tmp, $());
            }
        }

        var bundlePath = targetBundle();
        if (!bundlePath) {
            var missing = STEAM
                ? '"' + STEAM.name + '" is not installed in any Steam library.'
                : 'Could not work out where this application lives on disk.';
            return { ok: true, found: false, reason: missing };
        }

        var iconPath = iconFileFor(bundlePath);
        if (!iconPath) {
            return { ok: true, found: false, reason: 'No .icns icon was found inside ' + bundlePath + '.' };
        }

        var png = renderPng(iconPath);
        if (!png) {
            return { ok: true, found: false, reason: 'The icon in ' + iconPath + ' could not be converted.' };
        }

        // Dimensions are decoration in the PI's status line, and sips has
        // already capped them; reporting the cap is honest enough for that.
        return { ok: true, found: true, path: iconPath, width: MAX_PX, height: MAX_PX, png: png };
`,
		`${APP_HELPERS}\n${steam ? `STEAM = ${jsLiteral(steam)};\n` : ""}`,
	);
}
