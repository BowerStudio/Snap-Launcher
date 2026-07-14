<#
.SYNOPSIS
One-command dev & deployment helper for the Snap Launcher Stream Deck plugin.

.DESCRIPTION
Installs npm dependencies (and the Elgato Maker CLI when a task needs it),
builds the plugin bundle, and runs the requested task. Run from anywhere; the
script always operates on its own repo.

.PARAMETER Task
  build    Install dependencies and build the plugin bundle. (default)
  link     Build, then link the .sdPlugin folder into Stream Deck — one-time dev setup.
  watch    Ensure the plugin is linked, then rebuild on every save and restart it in Stream Deck. Ctrl+C to stop.
  pack     Build and produce the shareable .streamDeckPlugin installer in the repo root.
  restart  Just restart the plugin inside Stream Deck.

.PARAMETER SkipInstall
Skip the "npm install" step (useful when dependencies are known to be current).

.EXAMPLE
.\dev.ps1
Install dependencies and build.

.EXAMPLE
.\dev.ps1 watch
The dev loop: save a file, the plugin rebuilds and restarts.

.EXAMPLE
.\dev.ps1 pack
Create com.bowerstudio.snap-launcher.streamDeckPlugin for distribution.
#>
[CmdletBinding()]
param(
	[Parameter(Position = 0)]
	[ValidateSet("build", "link", "watch", "pack", "restart")]
	[string]$Task = "build",

	[switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$PluginId = "com.bowerstudio.snap-launcher"
$SdPlugin = "$PluginId.sdPlugin"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step([string]$Message) {
	Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Checked([string]$Description, [scriptblock]$Block) {
	Write-Step $Description
	& $Block
	if ($LASTEXITCODE -ne 0) {
		throw "$Description failed (exit code $LASTEXITCODE)."
	}
}

function Assert-Node {
	if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
		throw "Node.js is not installed (or not on PATH). Install Node.js 24+ from https://nodejs.org and re-run."
	}
	$version = (& node --version).TrimStart("v")
	if ([int]$version.Split(".")[0] -lt 24) {
		Write-Warning "Node.js 24+ is recommended; found v$version. The build may still work, but 'npm test' needs a Node that runs TypeScript directly."
	}
}

# The Elgato Maker CLI provides the 'streamdeck' command (link/restart/pack).
function Assert-StreamDeckCli {
	if (Get-Command streamdeck -ErrorAction SilentlyContinue) { return }
	Invoke-Checked "Installing the Elgato Maker CLI (npm install -g @elgato/cli)" { npm install -g @elgato/cli }
	if (-not (Get-Command streamdeck -ErrorAction SilentlyContinue)) {
		throw "The 'streamdeck' command is still not on PATH. Open a new terminal and re-run this script."
	}
}

function Test-Linked {
	return (Test-Path -LiteralPath (Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins\$SdPlugin"))
}

function Assert-Linked {
	if (Test-Linked) { return }
	# Stream Deck loads the linked folder immediately, so make sure there is a
	# built bundle in it before creating the link.
	if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "$SdPlugin\bin\plugin.js"))) {
		Invoke-Checked "Building the plugin bundle" { npm run build }
	}
	Invoke-Checked "Linking $SdPlugin into Stream Deck" { streamdeck link (Join-Path $RepoRoot $SdPlugin) }
}

Push-Location $RepoRoot
try {
	Assert-Node

	if (-not $SkipInstall -and $Task -ne "restart") {
		Invoke-Checked "Installing npm dependencies" { npm install }
	}

	switch ($Task) {
		"build" {
			Invoke-Checked "Building the plugin bundle" { npm run build }
			Write-Step "Done. Next: '.\dev.ps1 link' to install into Stream Deck, or '.\dev.ps1 watch' for the dev loop."
		}
		"link" {
			Assert-StreamDeckCli
			Invoke-Checked "Building the plugin bundle" { npm run build }
			Assert-Linked
			Write-Step "Done. The plugin now runs from this repo; after future builds run '.\dev.ps1 restart' (or use '.\dev.ps1 watch')."
		}
		"watch" {
			Assert-StreamDeckCli
			Assert-Linked
			Write-Step "Watching for changes - every save rebuilds and restarts the plugin. Ctrl+C to stop."
			# Not Invoke-Checked: Ctrl+C ends the watcher with a non-zero exit
			# code, which is not a failure.
			npm run watch
		}
		"pack" {
			Assert-StreamDeckCli
			Invoke-Checked "Building the plugin bundle" { npm run build }

			$manifest = Get-Content -LiteralPath (Join-Path $RepoRoot "$SdPlugin\manifest.json") -Raw | ConvertFrom-Json
			if ($manifest.Nodejs.Debug -ne "disabled") {
				Write-Warning "manifest.json has Nodejs.Debug = '$($manifest.Nodejs.Debug)'. Set it to 'disabled' before publishing a release."
			}

			$packed = Join-Path $RepoRoot "$PluginId.streamDeckPlugin"
			if (Test-Path -LiteralPath $packed) {
				Write-Step "Removing the previously packed file"
				Remove-Item -LiteralPath $packed -Force -Confirm:$false
			}
			Invoke-Checked "Packing the release installer" { streamdeck pack $SdPlugin }
			Write-Step "Packed: $packed"
			Write-Step "Double-click that file on the TARGET machine to install. Don't install it on THIS machine while the dev link is active (same UUID)."
		}
		"restart" {
			Assert-StreamDeckCli
			Invoke-Checked "Restarting the plugin" { streamdeck restart $PluginId }
		}
	}
} finally {
	Pop-Location
}
