<#
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-06-25 03:57:08
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  9FB1DF2C65CF54F9A07A67401A93B922D1F5BD053DBD153D30BA261A43AE657A
SHA-512:  B2CCDADD1AD28B2174AE260C4A196DF86C146E522107B6D4BBCCBA804EF2D9360E359C98C1AB2A9C719EF012E7648284C7AA5C78E27AB25EE6B76A918752F534
MD5:      A6BC1D7CA746F4B381F17C70F312DBA5
File Size: 63389 bytes

LICENSE:
PROPRIETARY LICENSE

Copyright (c) 2026 Leon Sage. All Rights Reserved.
Sage Audio LLC

This software is proprietary and confidential property of Leon Sage.
UNAUTHORIZED COPYING, MODIFICATION, DISTRIBUTION, OR USE IS STRICTLY PROHIBITED.

⚠️  ANTI-THEFT NOTICE:
This code is cryptographically signed and protected. Any
unauthorized modification, distribution, or removal of this
protection constitutes copyright infringement.
═══════════════════════════════════════════════════════════
#>
#Requires -Version 7.6
<#
.SYNOPSIS
    Safety King - Windows Environment Health, Conflict Resolution, and Package Management TUI
.DESCRIPTION
    Scans Windows-side package managers (winget, choco, scoop), cross-platform tools (Node/npm,
    Python/pip, Rust/cargo/rustup), PATH integrity, WSL bleed detection, vulnerability auditing,
    and cross-environment version mismatch detection between Windows and WSL.
    Nothing runs automatically. Every action requires explicit Y/N confirmation.
    No silent suppression. No auto-scans. No background actions.
.NOTES
    Requires: pwsh 7.6.3 LTS
    TUI: Microsoft.PowerShell.ConsoleGuiTools (Terminal.Gui)
    Author: Safety King
    Version: 1.0.0
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region --- Constants and Config Path ---

$script:CONFIG_PATH = Join-Path $env:APPDATA 'SafetyKing\config.json'
$script:REPORT_DIR  = Join-Path $env:USERPROFILE 'SafetyKingReports'
$script:VERSION     = '1.0.0'

#endregion

#region --- Configuration ---

function Get-DefaultConfig {
    return @{
        PackageManagers = @{
            Winget = $true
            Choco  = $true
            Scoop  = $true
        }
        CrossPlatform = @{
            Npm   = $true
            Pip   = $true
            Cargo = $true
        }
        UpdateChannel        = 'LTS'
        ReportOutputPath     = $script:REPORT_DIR
        CheckWSLMismatches   = $true
        ScanDepth            = 'Deep'
    }
}

function Load-Config {
    if (Test-Path $script:CONFIG_PATH) {
        try {
            $raw = Get-Content $script:CONFIG_PATH -Raw -ErrorAction Stop
            return $raw | ConvertFrom-Json -AsHashtable
        } catch {
            Write-SafetyLog "Config load failed, using defaults: $_" 'WARN'
            return Get-DefaultConfig
        }
    }
    return Get-DefaultConfig
}

function Save-Config {
    param([hashtable]$Config)
    $dir = Split-Path $script:CONFIG_PATH -Parent
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $Config | ConvertTo-Json -Depth 10 | Set-Content $script:CONFIG_PATH -Encoding UTF8
}

#endregion

#region --- Logging ---

function Write-SafetyLog {
    param(
        [string]$Message,
        [ValidateSet('INFO','WARN','ERROR','ACTION')][string]$Level = 'INFO'
    )
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $logDir = Join-Path $env:APPDATA 'SafetyKing\logs'
    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    $logFile = Join-Path $logDir "safetyking-$(Get-Date -Format 'yyyy-MM-dd').log"
    "[$ts][$Level] $Message" | Add-Content -Path $logFile -Encoding UTF8
}

#endregion

#region --- Tool Detection ---

function Test-CommandExists {
    param([string]$Command)
    return [bool](Get-Command $Command -ErrorAction SilentlyContinue)
}

function Get-InstalledPackageManagers {
    $result = @{}
    $result['Winget'] = Test-CommandExists 'winget'
    $result['Choco']  = Test-CommandExists 'choco'
    $result['Scoop']  = Test-CommandExists 'scoop'
    return $result
}

function Get-InstalledCrossPlatformTools {
    $result = @{}
    $result['Node']   = Test-CommandExists 'node'
    $result['Npm']    = Test-CommandExists 'npm'
    $result['Python'] = (Test-CommandExists 'python') -or (Test-CommandExists 'python3')
    $result['Pip']    = (Test-CommandExists 'pip') -or (Test-CommandExists 'pip3')
    $result['Rustup'] = Test-CommandExists 'rustup'
    $result['Cargo']  = Test-CommandExists 'cargo'
    $result['Rustc']  = Test-CommandExists 'rustc'
    return $result
}

#endregion

#region --- Scan Functions ---

function Invoke-ScanDuplicateVersions {
    param([hashtable]$Config)
    $findings = [System.Collections.Generic.List[hashtable]]::new()

    if ($Config.PackageManagers.Winget -and (Test-CommandExists 'winget')) {
        Write-Host "`n[WINGET] Scanning for duplicate tool versions..." -ForegroundColor Cyan
        try {
            $wingetList = winget list 2>&1
            $toolVersionMap = @{}
            foreach ($line in $wingetList) {
                if ($line -match '^\S') {
                    $parts = $line -split '\s{2,}'
                    if ($parts.Count -ge 2) {
                        $name    = $parts[0].Trim()
                        $version = if ($parts.Count -ge 3) { $parts[2].Trim() } else { $parts[1].Trim() }
                        if ($toolVersionMap.ContainsKey($name)) {
                            $toolVersionMap[$name] += @($version)
                        } else {
                            $toolVersionMap[$name] = @($version)
                        }
                    }
                }
            }
            foreach ($tool in $toolVersionMap.Keys) {
                if ($toolVersionMap[$tool].Count -gt 1) {
                    $findings.Add(@{
                        Source    = 'Winget'
                        Tool      = $tool
                        Versions  = $toolVersionMap[$tool]
                        Severity  = 'HIGH'
                        Action    = 'DUPLICATE'
                    })
                }
            }
        } catch {
            Write-SafetyLog "Winget duplicate scan failed: $_" 'ERROR'
            Write-Host "[WINGET] Scan failed: $_" -ForegroundColor Red
        }
    }

    if ($Config.PackageManagers.Choco -and (Test-CommandExists 'choco')) {
        Write-Host "[CHOCO] Scanning for duplicate tool versions..." -ForegroundColor Cyan
        try {
            $chocoList = choco list 2>&1
            $chocoMap  = @{}
            foreach ($line in $chocoList) {
                if ($line -match '^(\S+)\s+([\d\.]+)') {
                    $name    = $Matches[1]
                    $version = $Matches[2]
                    if ($chocoMap.ContainsKey($name)) {
                        $chocoMap[$name] += @($version)
                    } else {
                        $chocoMap[$name] = @($version)
                    }
                }
            }
            foreach ($tool in $chocoMap.Keys) {
                if ($chocoMap[$tool].Count -gt 1) {
                    $findings.Add(@{
                        Source   = 'Choco'
                        Tool     = $tool
                        Versions = $chocoMap[$tool]
                        Severity = 'HIGH'
                        Action   = 'DUPLICATE'
                    })
                }
            }
        } catch {
            Write-SafetyLog "Choco duplicate scan failed: $_" 'ERROR'
            Write-Host "[CHOCO] Scan failed: $_" -ForegroundColor Red
        }
    }

    if ($Config.PackageManagers.Scoop -and (Test-CommandExists 'scoop')) {
        Write-Host "[SCOOP] Scanning for duplicate tool versions..." -ForegroundColor Cyan
        try {
            $scoopList = scoop list 2>&1
            $scoopMap  = @{}
            foreach ($line in $scoopList) {
                if ($line -match '^(\S+)\s+([\d\.]+)') {
                    $name    = $Matches[1]
                    $version = $Matches[2]
                    if ($scoopMap.ContainsKey($name)) {
                        $scoopMap[$name] += @($version)
                    } else {
                        $scoopMap[$name] = @($version)
                    }
                }
            }
            foreach ($tool in $scoopMap.Keys) {
                if ($scoopMap[$tool].Count -gt 1) {
                    $findings.Add(@{
                        Source   = 'Scoop'
                        Tool     = $tool
                        Versions = $scoopMap[$tool]
                        Severity = 'HIGH'
                        Action   = 'DUPLICATE'
                    })
                }
            }
        } catch {
            Write-SafetyLog "Scoop duplicate scan failed: $_" 'ERROR'
            Write-Host "[SCOOP] Scan failed: $_" -ForegroundColor Red
        }
    }

    return $findings
}

function Invoke-ScanOutdatedVersions {
    param([hashtable]$Config)
    $findings = [System.Collections.Generic.List[hashtable]]::new()

    # PowerShell version check
    $currentPS = $PSVersionTable.PSVersion
    $latestPS  = '7.6.3'
    if ($currentPS.ToString() -ne $latestPS) {
        $findings.Add(@{
            Source   = 'PowerShell'
            Tool     = 'PowerShell'
            Current  = $currentPS.ToString()
            Latest   = $latestPS
            Severity = 'MEDIUM'
            Action   = 'UPDATE'
        })
    }

    if ($Config.PackageManagers.Winget -and (Test-CommandExists 'winget')) {
        Write-Host "`n[WINGET] Scanning for outdated packages..." -ForegroundColor Cyan
        try {
            $outdated = winget upgrade 2>&1
            foreach ($line in $outdated) {
                if ($line -match '^(\S.+?)\s{2,}([\d\.]+)\s{2,}([\d\.]+)') {
                    $findings.Add(@{
                        Source   = 'Winget'
                        Tool     = $Matches[1].Trim()
                        Current  = $Matches[2].Trim()
                        Latest   = $Matches[3].Trim()
                        Severity = 'MEDIUM'
                        Action   = 'UPDATE'
                    })
                }
            }
        } catch {
            Write-SafetyLog "Winget outdated scan failed: $_" 'ERROR'
            Write-Host "[WINGET] Outdated scan failed: $_" -ForegroundColor Red
        }
    }

    if ($Config.PackageManagers.Choco -and (Test-CommandExists 'choco')) {
        Write-Host "[CHOCO] Scanning for outdated packages..." -ForegroundColor Cyan
        try {
            $chocoOutdated = choco outdated 2>&1
            foreach ($line in $chocoOutdated) {
                if ($line -match '^(\S+)\|(\S+)\|(\S+)') {
                    $findings.Add(@{
                        Source   = 'Choco'
                        Tool     = $Matches[1]
                        Current  = $Matches[2]
                        Latest   = $Matches[3]
                        Severity = 'MEDIUM'
                        Action   = 'UPDATE'
                    })
                }
            }
        } catch {
            Write-SafetyLog "Choco outdated scan failed: $_" 'ERROR'
            Write-Host "[CHOCO] Outdated scan failed: $_" -ForegroundColor Red
        }
    }

    if ($Config.PackageManagers.Scoop -and (Test-CommandExists 'scoop')) {
        Write-Host "[SCOOP] Scanning for outdated packages..." -ForegroundColor Cyan
        try {
            $scoopStatus = scoop status 2>&1
            foreach ($line in $scoopStatus) {
                if ($line -match '^(\S+)\s+([\d\.]+)\s+([\d\.]+)') {
                    $findings.Add(@{
                        Source   = 'Scoop'
                        Tool     = $Matches[1]
                        Current  = $Matches[2]
                        Latest   = $Matches[3]
                        Severity = 'MEDIUM'
                        Action   = 'UPDATE'
                    })
                }
            }
        } catch {
            Write-SafetyLog "Scoop outdated scan failed: $_" 'ERROR'
            Write-Host "[SCOOP] Outdated scan failed: $_" -ForegroundColor Red
        }
    }

    if ($Config.CrossPlatform.Npm -and (Test-CommandExists 'npm')) {
        Write-Host "[NPM] Scanning for outdated global packages..." -ForegroundColor Cyan
        try {
            $npmOutdated = npm outdated -g --json 2>&1 | ConvertFrom-Json -AsHashtable
            foreach ($pkg in $npmOutdated.Keys) {
                $findings.Add(@{
                    Source   = 'npm-global'
                    Tool     = $pkg
                    Current  = $npmOutdated[$pkg].current
                    Latest   = $npmOutdated[$pkg].latest
                    Severity = 'MEDIUM'
                    Action   = 'UPDATE'
                })
            }
        } catch {
            Write-SafetyLog "npm outdated scan failed: $_" 'WARN'
            Write-Host "[NPM] Outdated scan failed: $_" -ForegroundColor Yellow
        }
    }

    if ($Config.CrossPlatform.Pip -and (Test-CommandExists 'pip')) {
        Write-Host "[PIP] Scanning for outdated packages..." -ForegroundColor Cyan
        try {
            $pipOutdated = pip list --outdated --format=json 2>&1 | ConvertFrom-Json
            foreach ($pkg in $pipOutdated) {
                $findings.Add(@{
                    Source   = 'pip'
                    Tool     = $pkg.name
                    Current  = $pkg.version
                    Latest   = $pkg.latest_version
                    Severity = 'MEDIUM'
                    Action   = 'UPDATE'
                })
            }
        } catch {
            Write-SafetyLog "pip outdated scan failed: $_" 'WARN'
            Write-Host "[PIP] Outdated scan failed: $_" -ForegroundColor Yellow
        }
    }

    if ($Config.CrossPlatform.Cargo -and (Test-CommandExists 'rustup')) {
        Write-Host "[RUSTUP] Checking Rust toolchain version..." -ForegroundColor Cyan
        try {
            $rustupCheck = rustup check 2>&1
            foreach ($line in $rustupCheck) {
                if ($line -match 'Update available') {
                    $findings.Add(@{
                        Source   = 'rustup'
                        Tool     = 'Rust Toolchain'
                        Current  = 'See rustup check output'
                        Latest   = 'Update available'
                        Severity = 'MEDIUM'
                        Action   = 'UPDATE'
                        Raw      = $line
                    })
                }
            }
        } catch {
            Write-SafetyLog "rustup check failed: $_" 'WARN'
            Write-Host "[RUSTUP] Check failed: $_" -ForegroundColor Yellow
        }
    }

    return $findings
}

function Invoke-ScanPathConflicts {
    $findings = [System.Collections.Generic.List[hashtable]]::new()
    Write-Host "`n[PATH] Scanning Windows PATH for conflicts and pollution..." -ForegroundColor Cyan

    $systemPath = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') -split ';' | Where-Object { $_ -ne '' }
    $userPath   = [System.Environment]::GetEnvironmentVariable('PATH', 'User')   -split ';' | Where-Object { $_ -ne '' }
    $allPaths   = $systemPath + $userPath

    # Ghost paths - listed but don't exist
    foreach ($entry in $allPaths) {
        if (-not (Test-Path $entry)) {
            $findings.Add(@{
                Source   = 'PATH'
                Type     = 'GHOST'
                Entry    = $entry
                Severity = 'MEDIUM'
                Action   = 'REMOVE'
                Detail   = 'Path entry does not exist on disk'
            })
        }
    }

    # Duplicate entries
    $seen = @{}
    foreach ($entry in $allPaths) {
        $normalized = $entry.TrimEnd('\').ToLower()
        if ($seen.ContainsKey($normalized)) {
            $findings.Add(@{
                Source   = 'PATH'
                Type     = 'DUPLICATE'
                Entry    = $entry
                Severity = 'LOW'
                Action   = 'REMOVE'
                Detail   = 'Duplicate PATH entry'
            })
        } else {
            $seen[$normalized] = $true
        }
    }

    # Same tool registered in multiple PATH locations
    $toolLocations = @{}
    foreach ($entry in $allPaths) {
        if (Test-Path $entry) {
            $exes = Get-ChildItem -Path $entry -Filter '*.exe' -ErrorAction SilentlyContinue
            foreach ($exe in $exes) {
                $name = $exe.Name.ToLower()
                if ($toolLocations.ContainsKey($name)) {
                    $toolLocations[$name] += @($entry)
                } else {
                    $toolLocations[$name] = @($entry)
                }
            }
        }
    }
    foreach ($tool in $toolLocations.Keys) {
        if ($toolLocations[$tool].Count -gt 1) {
            $findings.Add(@{
                Source    = 'PATH'
                Type      = 'TOOL_CONFLICT'
                Tool      = $tool
                Locations = $toolLocations[$tool]
                Severity  = 'HIGH'
                Action    = 'REVIEW'
                Detail    = "Tool '$tool' found in $($toolLocations[$tool].Count) PATH locations"
            })
        }
    }

    return $findings
}

function Invoke-ScanWSLBleed {
    $findings = [System.Collections.Generic.List[hashtable]]::new()
    Write-Host "`n[WSL-BLEED] Scanning for Windows PATH entries bleeding into WSL..." -ForegroundColor Cyan

    # Check if WSL is available
    if (-not (Test-CommandExists 'wsl')) {
        Write-Host "[WSL-BLEED] WSL not detected on this system. Skipping." -ForegroundColor Yellow
        return $findings
    }

    try {
        # Get WSL PATH to check what Windows is injecting
        $wslPath = wsl bash -c 'echo $PATH' 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[WSL-BLEED] Could not query WSL PATH. Is a distro installed?" -ForegroundColor Yellow
            return $findings
        }

        $wslEntries = $wslPath -split ':'
        foreach ($entry in $wslEntries) {
            # /mnt/c/ etc are Windows drives mounted in WSL
            if ($entry -match '^/mnt/[a-z]/') {
                $findings.Add(@{
                    Source   = 'WSL-BLEED'
                    Type     = 'WINDOWS_PATH_IN_WSL'
                    Entry    = $entry
                    Severity = 'MEDIUM'
                    Action   = 'REVIEW'
                    Detail   = 'Windows drive path is present in WSL PATH. Verify this is intentional.'
                })
            }
        }

        # Check WSLENV for problematic variable forwarding
        $wslEnv = [System.Environment]::GetEnvironmentVariable('WSLENV', 'User')
        if ($wslEnv) {
            $findings.Add(@{
                Source   = 'WSL-BLEED'
                Type     = 'WSLENV_SET'
                Entry    = $wslEnv
                Severity = 'LOW'
                Action   = 'REVIEW'
                Detail   = "WSLENV is set to '$wslEnv' — verify these variables should be shared with WSL"
            })
        }
    } catch {
        Write-SafetyLog "WSL bleed scan failed: $_" 'ERROR'
        Write-Host "[WSL-BLEED] Scan failed: $_" -ForegroundColor Red
    }

    return $findings
}

function Invoke-ScanUnverifiedPackages {
    param([hashtable]$Config)
    $findings = [System.Collections.Generic.List[hashtable]]::new()

    if ($Config.PackageManagers.Winget -and (Test-CommandExists 'winget')) {
        Write-Host "`n[WINGET] Scanning for unverified packages..." -ForegroundColor Cyan
        try {
            $wingetList = winget list --source winget 2>&1
            foreach ($line in $wingetList) {
                # Packages not from the verified winget store show different source tags
                if ($line -match 'Unknown' -or $line -match 'msstore' -or $line -notmatch 'winget') {
                    if ($line -match '^(\S.+?)\s{2,}') {
                        $findings.Add(@{
                            Source   = 'Winget'
                            Tool     = $Matches[1].Trim()
                            Severity = 'MEDIUM'
                            Action   = 'REVIEW'
                            Detail   = "Package source is unverified or from an alternate source: $line"
                        })
                    }
                }
            }
        } catch {
            Write-SafetyLog "Winget unverified scan failed: $_" 'ERROR'
            Write-Host "[WINGET] Unverified scan failed: $_" -ForegroundColor Red
        }
    }

    if ($Config.PackageManagers.Choco -and (Test-CommandExists 'choco')) {
        Write-Host "[CHOCO] Scanning for unverified packages..." -ForegroundColor Cyan
        try {
            $chocoList = choco list --local-only 2>&1
            foreach ($line in $chocoList) {
                if ($line -match '^(\S+)\s+([\d\.]+)') {
                    $pkgName = $Matches[1]
                    # Check if package is from community repo vs verified
                    $chocoInfo = choco info $pkgName 2>&1
                    if ($chocoInfo -match 'unverified|not verified|community') {
                        $findings.Add(@{
                            Source   = 'Choco'
                            Tool     = $pkgName
                            Severity = 'MEDIUM'
                            Action   = 'REVIEW'
                            Detail   = 'Package is from unverified community source'
                        })
                    }
                }
            }
        } catch {
            Write-SafetyLog "Choco unverified scan failed: $_" 'WARN'
            Write-Host "[CHOCO] Unverified scan failed: $_" -ForegroundColor Yellow
        }
    }

    return $findings
}

function Invoke-ScanVersionLocks {
    param([hashtable]$Config)
    $findings = [System.Collections.Generic.List[hashtable]]::new()
    Write-Host "`n[VERSION-LOCKS] Scanning for packages blocking uninstalls..." -ForegroundColor Cyan

    if ($Config.PackageManagers.Winget -and (Test-CommandExists 'winget')) {
        try {
            # winget shows dependency info in upgrade output
            $wingetUpgrade = winget upgrade 2>&1
            foreach ($line in $wingetUpgrade) {
                if ($line -match 'requires|dependency|depends') {
                    $findings.Add(@{
                        Source   = 'Winget'
                        Severity = 'HIGH'
                        Action   = 'REVIEW'
                        Detail   = "Dependency chain detected: $line"
                    })
                }
            }
        } catch {
            Write-SafetyLog "Winget version lock scan failed: $_" 'WARN'
        }
    }

    if ($Config.PackageManagers.Choco -and (Test-CommandExists 'choco')) {
        try {
            $chocoPin = choco pin list 2>&1
            foreach ($line in $chocoPin) {
                if ($line -match '^(\S+)\|(\S+)') {
                    $findings.Add(@{
                        Source   = 'Choco'
                        Tool     = $Matches[1]
                        Version  = $Matches[2]
                        Severity = 'MEDIUM'
                        Action   = 'REVIEW'
                        Detail   = "Package is pinned and will not update: $($Matches[1]) @ $($Matches[2])"
                    })
                }
            }
        } catch {
            Write-SafetyLog "Choco pin scan failed: $_" 'WARN'
        }
    }

    # Check npm global packages for peer dependency conflicts
    if ($Config.CrossPlatform.Npm -and (Test-CommandExists 'npm')) {
        try {
            $npmList = npm list -g --json 2>&1
            $npmObj  = $npmList | ConvertFrom-Json -AsHashtable
            if ($npmObj.ContainsKey('problems')) {
                foreach ($problem in $npmObj['problems']) {
                    $findings.Add(@{
                        Source   = 'npm-global'
                        Severity = 'HIGH'
                        Action   = 'RESOLVE'
                        Detail   = $problem
                    })
                }
            }
        } catch {
            Write-SafetyLog "npm version lock scan failed: $_" 'WARN'
        }
    }

    return $findings
}

function Invoke-ScanGlobalLocalConflicts {
    param([hashtable]$Config)
    $findings = [System.Collections.Generic.List[hashtable]]::new()
    Write-Host "`n[GLOBAL-LOCAL] Scanning for global vs local install conflicts..." -ForegroundColor Cyan

    if ($Config.CrossPlatform.Npm -and (Test-CommandExists 'npm')) {
        try {
            $globalPackages = npm list -g --depth=0 --json 2>&1 | ConvertFrom-Json -AsHashtable
            $globalDeps     = if ($globalPackages.ContainsKey('dependencies')) { $globalPackages['dependencies'] } else { @{} }

            # Walk current directory and common project roots for local npm installs
            $searchRoots = @($env:USERPROFILE, 'C:\Projects', 'C:\Dev', 'C:\code') | Where-Object { Test-Path $_ }
            foreach ($root in $searchRoots) {
                $packageJsonFiles = Get-ChildItem -Path $root -Filter 'package.json' -Recurse -Depth 4 -ErrorAction SilentlyContinue
                foreach ($pjFile in $packageJsonFiles) {
                    if ($pjFile.FullName -match 'node_modules') { continue }
                    try {
                        $pj       = Get-Content $pjFile.FullName -Raw | ConvertFrom-Json -AsHashtable
                        $allLocal = @{}
                        if ($pj.ContainsKey('dependencies'))    { $pj['dependencies'].Keys    | ForEach-Object { $allLocal[$_] = $true } }
                        if ($pj.ContainsKey('devDependencies')) { $pj['devDependencies'].Keys | ForEach-Object { $allLocal[$_] = $true } }
                        foreach ($pkg in $globalDeps.Keys) {
                            if ($allLocal.ContainsKey($pkg)) {
                                $findings.Add(@{
                                    Source   = 'npm'
                                    Tool     = $pkg
                                    Severity = 'MEDIUM'
                                    Action   = 'REVIEW'
                                    Detail   = "Package '$pkg' is installed globally AND locally in $($pjFile.DirectoryName)"
                                })
                            }
                        }
                    } catch {
                        Write-SafetyLog "Could not parse $($pjFile.FullName): $_" 'WARN'
                    }
                }
            }
        } catch {
            Write-SafetyLog "npm global/local conflict scan failed: $_" 'WARN'
            Write-Host "[NPM] Global/local conflict scan failed: $_" -ForegroundColor Yellow
        }
    }

    if ($Config.CrossPlatform.Pip -and (Test-CommandExists 'pip')) {
        try {
            $pipGlobal = pip list --format=json 2>&1 | ConvertFrom-Json
            # Check for venvs in common locations
            $venvRoots = @($env:USERPROFILE, 'C:\Projects', 'C:\Dev') | Where-Object { Test-Path $_ }
            foreach ($root in $venvRoots) {
                $venvActivate = Get-ChildItem -Path $root -Filter 'activate.ps1' -Recurse -Depth 5 -ErrorAction SilentlyContinue
                foreach ($venv in $venvActivate) {
                    $venvPip = Join-Path $venv.DirectoryName '..\Scripts\pip.exe'
                    if (Test-Path $venvPip) {
                        try {
                            $venvPkgs = & $venvPip list --format=json 2>&1 | ConvertFrom-Json
                            $venvNames = $venvPkgs | ForEach-Object { $_.name }
                            foreach ($gpkg in $pipGlobal) {
                                if ($gpkg.name -in $venvNames) {
                                    $findings.Add(@{
                                        Source   = 'pip'
                                        Tool     = $gpkg.name
                                        Severity = 'MEDIUM'
                                        Action   = 'REVIEW'
                                        Detail   = "Package '$($gpkg.name)' exists in global pip AND in venv at $($venv.DirectoryName)"
                                    })
                                }
                            }
                        } catch {
                            Write-SafetyLog "venv pip list failed for $($venv.FullName): $_" 'WARN'
                        }
                    }
                }
            }
        } catch {
            Write-SafetyLog "pip global/local conflict scan failed: $_" 'WARN'
        }
    }

    return $findings
}

function Invoke-ScanVulnerabilities {
    param([hashtable]$Config)
    $findings = [System.Collections.Generic.List[hashtable]]::new()
    Write-Host "`n[VULN] Scanning for vulnerabilities in installed packages..." -ForegroundColor Cyan

    if ($Config.PackageManagers.Winget -and (Test-CommandExists 'winget')) {
        try {
            $wingetUpgrade = winget upgrade --include-unknown 2>&1
            foreach ($line in $wingetUpgrade) {
                if ($line -match 'CVE|vulnerability|security|critical') {
                    $findings.Add(@{
                        Source   = 'Winget'
                        Severity = 'CRITICAL'
                        Action   = 'UPDATE'
                        Detail   = $line.Trim()
                    })
                }
            }
        } catch {
            Write-SafetyLog "Winget vulnerability scan failed: $_" 'WARN'
        }
    }

    if ($Config.CrossPlatform.Npm -and (Test-CommandExists 'npm')) {
        Write-Host "[NPM] Running npm audit on global packages..." -ForegroundColor Cyan
        try {
            $npmAudit = npm audit --json -g 2>&1
            $auditObj = $npmAudit | ConvertFrom-Json -AsHashtable
            if ($auditObj.ContainsKey('vulnerabilities')) {
                foreach ($vuln in $auditObj['vulnerabilities'].Keys) {
                    $v = $auditObj['vulnerabilities'][$vuln]
                    $findings.Add(@{
                        Source   = 'npm-global'
                        Tool     = $vuln
                        Severity = $v['severity'].ToUpper()
                        Action   = 'UPDATE'
                        Detail   = "npm audit: $($v['title']) — via $($v['via'] -join ', ')"
                    })
                }
            }
        } catch {
            Write-SafetyLog "npm audit failed: $_" 'WARN'
            Write-Host "[NPM] audit failed or no vulnerabilities found: $_" -ForegroundColor Yellow
        }
    }

    if ($Config.CrossPlatform.Cargo -and (Test-CommandExists 'cargo')) {
        Write-Host "[CARGO] Running cargo audit..." -ForegroundColor Cyan
        if (Test-CommandExists 'cargo-audit') {
            try {
                $cargoAudit = cargo audit --json 2>&1
                $auditObj   = $cargoAudit | ConvertFrom-Json -AsHashtable
                if ($auditObj.ContainsKey('vulnerabilities') -and $auditObj['vulnerabilities']['found']) {
                    foreach ($v in $auditObj['vulnerabilities']['list']) {
                        $findings.Add(@{
                            Source   = 'cargo'
                            Tool     = $v['advisory']['package']
                            Severity = $v['advisory']['cvss'] ?? 'UNKNOWN'
                            Action   = 'UPDATE'
                            Detail   = "$($v['advisory']['title']) — $($v['advisory']['id'])"
                        })
                    }
                }
            } catch {
                Write-SafetyLog "cargo audit failed: $_" 'WARN'
                Write-Host "[CARGO] cargo audit failed: $_" -ForegroundColor Yellow
            }
        } else {
            Write-Host "[CARGO] cargo-audit not installed. Install with: cargo install cargo-audit" -ForegroundColor Yellow
            $findings.Add(@{
                Source   = 'cargo'
                Tool     = 'cargo-audit'
                Severity = 'INFO'
                Action   = 'INSTALL'
                Detail   = 'cargo-audit is not installed. Run: cargo install cargo-audit to enable Rust vulnerability scanning.'
            })
        }
    }

    if ($Config.CrossPlatform.Pip -and (Test-CommandExists 'pip')) {
        Write-Host "[PIP] Running pip-audit..." -ForegroundColor Cyan
        if (Test-CommandExists 'pip-audit') {
            try {
                $pipAudit = pip-audit --format=json 2>&1
                $auditObj = $pipAudit | ConvertFrom-Json
                foreach ($v in $auditObj) {
                    foreach ($vuln in $v.vulns) {
                        $findings.Add(@{
                            Source   = 'pip'
                            Tool     = $v.name
                            Severity = 'HIGH'
                            Action   = 'UPDATE'
                            Detail   = "$($vuln.id): $($vuln.description) — fix: $($vuln.fix_versions -join ', ')"
                        })
                    }
                }
            } catch {
                Write-SafetyLog "pip-audit failed: $_" 'WARN'
                Write-Host "[PIP] pip-audit failed: $_" -ForegroundColor Yellow
            }
        } else {
            Write-Host "[PIP] pip-audit not installed. Install with: pip install pip-audit" -ForegroundColor Yellow
            $findings.Add(@{
                Source   = 'pip'
                Tool     = 'pip-audit'
                Severity = 'INFO'
                Action   = 'INSTALL'
                Detail   = 'pip-audit is not installed. Run: pip install pip-audit to enable Python vulnerability scanning.'
            })
        }
    }

    return $findings
}

function Invoke-ScanCrossEnvironmentMismatches {
    param([hashtable]$Config)
    $findings = [System.Collections.Generic.List[hashtable]]::new()

    if (-not $Config.CheckWSLMismatches) {
        Write-Host "`n[CROSS-ENV] Cross-environment mismatch checking is disabled in settings." -ForegroundColor Yellow
        return $findings
    }

    if (-not (Test-CommandExists 'wsl')) {
        Write-Host "`n[CROSS-ENV] WSL not available. Skipping cross-environment scan." -ForegroundColor Yellow
        return $findings
    }

    Write-Host "`n[CROSS-ENV] Scanning for version mismatches between Windows and WSL..." -ForegroundColor Cyan

    # Node version comparison
    if (Test-CommandExists 'node') {
        $winNode = node --version 2>&1
        try {
            $wslNode = wsl bash -c 'node --version 2>/dev/null || echo NOT_INSTALLED' 2>&1
            if ($wslNode -ne 'NOT_INSTALLED' -and $winNode -ne $wslNode) {
                $findings.Add(@{
                    Source      = 'Cross-Env'
                    Tool        = 'Node.js'
                    WindowsVer  = $winNode
                    WSLVer      = $wslNode
                    Severity    = 'HIGH'
                    Action      = 'REVIEW'
                    Detail      = "Node version mismatch: Windows=$winNode WSL=$wslNode"
                })
            }
        } catch {
            Write-SafetyLog "Cross-env Node check failed: $_" 'WARN'
        }
    }

    # Python version comparison
    $pythonCmd = if (Test-CommandExists 'python') { 'python' } elseif (Test-CommandExists 'python3') { 'python3' } else { $null }
    if ($pythonCmd) {
        $winPython = & $pythonCmd --version 2>&1
        try {
            $wslPython = wsl bash -c 'python3 --version 2>/dev/null || echo NOT_INSTALLED' 2>&1
            if ($wslPython -ne 'NOT_INSTALLED' -and $winPython -ne $wslPython) {
                $findings.Add(@{
                    Source      = 'Cross-Env'
                    Tool        = 'Python'
                    WindowsVer  = $winPython
                    WSLVer      = $wslPython
                    Severity    = 'MEDIUM'
                    Action      = 'REVIEW'
                    Detail      = "Python version mismatch: Windows=$winPython WSL=$wslPython"
                })
            }
        } catch {
            Write-SafetyLog "Cross-env Python check failed: $_" 'WARN'
        }
    }

    # npm version comparison
    if (Test-CommandExists 'npm') {
        $winNpm = npm --version 2>&1
        try {
            $wslNpm = wsl bash -c 'npm --version 2>/dev/null || echo NOT_INSTALLED' 2>&1
            if ($wslNpm -ne 'NOT_INSTALLED' -and $winNpm -ne $wslNpm) {
                $findings.Add(@{
                    Source      = 'Cross-Env'
                    Tool        = 'npm'
                    WindowsVer  = $winNpm
                    WSLVer      = $wslNpm
                    Severity    = 'MEDIUM'
                    Action      = 'REVIEW'
                    Detail      = "npm version mismatch: Windows=$winNpm WSL=$wslNpm"
                })
            }
        } catch {
            Write-SafetyLog "Cross-env npm check failed: $_" 'WARN'
        }
    }

    # Rust version comparison
    if (Test-CommandExists 'rustc') {
        $winRust = rustc --version 2>&1
        try {
            $wslRust = wsl bash -c 'rustc --version 2>/dev/null || echo NOT_INSTALLED' 2>&1
            if ($wslRust -ne 'NOT_INSTALLED' -and $winRust -ne $wslRust) {
                $findings.Add(@{
                    Source      = 'Cross-Env'
                    Tool        = 'Rust'
                    WindowsVer  = $winRust
                    WSLVer      = $wslRust
                    Severity    = 'MEDIUM'
                    Action      = 'REVIEW'
                    Detail      = "Rust version mismatch: Windows=$winRust WSL=$wslRust"
                })
            }
        } catch {
            Write-SafetyLog "Cross-env Rust check failed: $_" 'WARN'
        }
    }

    return $findings
}

#endregion

#region --- Action Functions ---

function Invoke-UpdatePackage {
    param(
        [string]$Source,
        [string]$Tool
    )
    Write-SafetyLog "User initiated update: $Source / $Tool" 'ACTION'
    switch ($Source.ToLower()) {
        'winget' {
            Write-Host "`n[ACTION] Running: winget upgrade $Tool" -ForegroundColor Green
            winget upgrade $Tool
        }
        'choco' {
            Write-Host "`n[ACTION] Running: choco upgrade $Tool -y" -ForegroundColor Green
            choco upgrade $Tool -y
        }
        'scoop' {
            Write-Host "`n[ACTION] Running: scoop update $Tool" -ForegroundColor Green
            scoop update $Tool
        }
        'npm-global' {
            Write-Host "`n[ACTION] Running: npm update -g $Tool" -ForegroundColor Green
            npm update -g $Tool
        }
        'pip' {
            Write-Host "`n[ACTION] Running: pip install --upgrade $Tool" -ForegroundColor Green
            pip install --upgrade $Tool
        }
        'rustup' {
            Write-Host "`n[ACTION] Running: rustup update stable" -ForegroundColor Green
            rustup update stable
        }
        'powershell' {
            Write-Host "`n[ACTION] Running: winget upgrade Microsoft.PowerShell" -ForegroundColor Green
            winget upgrade Microsoft.PowerShell
        }
        default {
            Write-Host "`n[ACTION] Unknown source '$Source'. Cannot auto-update. Please update manually." -ForegroundColor Yellow
        }
    }
    Write-SafetyLog "Update completed: $Source / $Tool" 'ACTION'
}

function Invoke-RemovePackage {
    param(
        [string]$Source,
        [string]$Tool
    )
    Write-SafetyLog "User initiated removal: $Source / $Tool" 'ACTION'
    switch ($Source.ToLower()) {
        'winget' {
            Write-Host "`n[ACTION] Running: winget uninstall $Tool" -ForegroundColor Red
            winget uninstall $Tool
        }
        'choco' {
            Write-Host "`n[ACTION] Running: choco uninstall $Tool -y" -ForegroundColor Red
            choco uninstall $Tool -y
        }
        'scoop' {
            Write-Host "`n[ACTION] Running: scoop uninstall $Tool" -ForegroundColor Red
            scoop uninstall $Tool
        }
        'npm-global' {
            Write-Host "`n[ACTION] Running: npm uninstall -g $Tool" -ForegroundColor Red
            npm uninstall -g $Tool
        }
        'pip' {
            Write-Host "`n[ACTION] Running: pip uninstall $Tool -y" -ForegroundColor Red
            pip uninstall $Tool -y
        }
        'rustup-toolchain' {
            Write-Host "`n[ACTION] Running: rustup toolchain uninstall $Tool" -ForegroundColor Red
            rustup toolchain uninstall $Tool
        }
        default {
            Write-Host "`n[ACTION] Unknown source '$Source'. Cannot auto-remove. Please remove manually." -ForegroundColor Yellow
        }
    }
    Write-SafetyLog "Removal completed: $Source / $Tool" 'ACTION'
}

function Remove-PathEntry {
    param(
        [string]$Entry,
        [ValidateSet('Machine','User')][string]$Scope
    )
    Write-SafetyLog "User initiated PATH removal: [$Scope] $Entry" 'ACTION'
    $current = [System.Environment]::GetEnvironmentVariable('PATH', $Scope) -split ';' | Where-Object { $_ -ne '' }
    $updated  = $current | Where-Object { $_.TrimEnd('\').ToLower() -ne $Entry.TrimEnd('\').ToLower() }
    $newPath  = $updated -join ';'
    [System.Environment]::SetEnvironmentVariable('PATH', $newPath, $Scope)
    Write-Host "[ACTION] Removed '$Entry' from $Scope PATH." -ForegroundColor Green
    Write-Host "[ACTION] Restart your terminal for changes to take effect." -ForegroundColor Yellow
    Write-SafetyLog "PATH entry removed: [$Scope] $Entry" 'ACTION'
}

#endregion

#region --- Report Export ---

function Export-Report {
    param(
        [System.Collections.Generic.List[hashtable]]$Findings,
        [string]$ScanType
    )
    if (-not (Test-Path $script:REPORT_DIR)) {
        New-Item -ItemType Directory -Path $script:REPORT_DIR -Force | Out-Null
    }
    $timestamp  = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
    $reportFile = Join-Path $script:REPORT_DIR "SafetyKing_${ScanType}_${timestamp}.txt"
    $lines      = [System.Collections.Generic.List[string]]::new()
    $lines.Add("SAFETY KING — $ScanType Report")
    $lines.Add("Generated: $(Get-Date)")
    $lines.Add("Total findings: $($Findings.Count)")
    $lines.Add('=' * 60)
    foreach ($f in $Findings) {
        $lines.Add('')
        foreach ($key in $f.Keys) {
            $lines.Add("  $key : $($f[$key])")
        }
        $lines.Add('-' * 40)
    }
    $lines | Set-Content -Path $reportFile -Encoding UTF8
    Write-Host "`n[REPORT] Saved to: $reportFile" -ForegroundColor Green
    Write-SafetyLog "Report exported: $reportFile" 'ACTION'
    return $reportFile
}

#endregion

#region --- Sub-Menu After Scan ---

function Show-FindingsSubMenu {
    param(
        [System.Collections.Generic.List[hashtable]]$Findings,
        [string]$ScanType
    )
    if ($Findings.Count -eq 0) {
        Write-Host "`n[OK] No findings for: $ScanType" -ForegroundColor Green
        Read-Host "`nPress ENTER to return to main menu"
        return
    }

    Write-Host "`n$('=' * 60)" -ForegroundColor Yellow
    Write-Host "  FINDINGS: $ScanType ($($Findings.Count) items)" -ForegroundColor Yellow
    Write-Host "$('=' * 60)" -ForegroundColor Yellow

    for ($i = 0; $i -lt $Findings.Count; $i++) {
        $f = $Findings[$i]
        $severityColor = switch ($f.Severity) {
            'CRITICAL' { 'Red' }
            'HIGH'     { 'Red' }
            'MEDIUM'   { 'Yellow' }
            'LOW'      { 'Cyan' }
            default    { 'White' }
        }
        Write-Host "`n  [$($i+1)] [$($f.Severity)] $($f.Detail)" -ForegroundColor $severityColor
        if ($f.ContainsKey('Tool'))    { Write-Host "       Tool   : $($f.Tool)"    -ForegroundColor Gray }
        if ($f.ContainsKey('Source'))  { Write-Host "       Source : $($f.Source)"  -ForegroundColor Gray }
        if ($f.ContainsKey('Current')) { Write-Host "       Current: $($f.Current)" -ForegroundColor Gray }
        if ($f.ContainsKey('Latest'))  { Write-Host "       Latest : $($f.Latest)"  -ForegroundColor Gray }
        if ($f.ContainsKey('Action'))  { Write-Host "       Action : $($f.Action)"  -ForegroundColor Gray }
    }

    $inSubMenu = $true
    while ($inSubMenu) {
        Write-Host "`n$('-' * 60)" -ForegroundColor DarkGray
        Write-Host "  SUB-MENU — $ScanType" -ForegroundColor Cyan
        Write-Host "  1. Update a finding by number"   -ForegroundColor White
        Write-Host "  2. Remove a finding by number"   -ForegroundColor White
        Write-Host "  3. View full details on a finding" -ForegroundColor White
        Write-Host "  4. Skip all and return to main menu" -ForegroundColor White
        Write-Host "  5. Export these results to report"  -ForegroundColor White
        Write-Host $('-' * 60) -ForegroundColor DarkGray

        $subChoice = Read-Host "  Enter choice [1-5]"
        switch ($subChoice.Trim()) {
            '1' {
                $idx = Read-Host "  Enter finding number to update"
                $idxInt = 0
                if ([int]::TryParse($idx, [ref]$idxInt) -and $idxInt -ge 1 -and $idxInt -le $Findings.Count) {
                    $finding = $Findings[$idxInt - 1]
                    $tool    = if ($finding.ContainsKey('Tool'))   { $finding['Tool']   } else { 'Unknown' }
                    $source  = if ($finding.ContainsKey('Source')) { $finding['Source'] } else { 'Unknown' }
                    Write-Host "`n  About to UPDATE: $tool from $source" -ForegroundColor Yellow
                    Write-Host "  Detail: $($finding['Detail'])" -ForegroundColor Gray
                    $confirm = Read-Host "  Are you sure? [Y/N]"
                    if ($confirm.Trim().ToUpper() -eq 'Y') {
                        Invoke-UpdatePackage -Source $source -Tool $tool
                    } else {
                        Write-Host "  Cancelled." -ForegroundColor Gray
                    }
                } else {
                    Write-Host "  Invalid number." -ForegroundColor Red
                }
            }
            '2' {
                $idx = Read-Host "  Enter finding number to remove"
                $idxInt = 0
                if ([int]::TryParse($idx, [ref]$idxInt) -and $idxInt -ge 1 -and $idxInt -le $Findings.Count) {
                    $finding = $Findings[$idxInt - 1]
                    $tool    = if ($finding.ContainsKey('Tool'))   { $finding['Tool']   } else { 'Unknown' }
                    $source  = if ($finding.ContainsKey('Source')) { $finding['Source'] } else { 'Unknown' }
                    Write-Host "`n  About to REMOVE: $tool from $source" -ForegroundColor Red
                    Write-Host "  Detail: $($finding['Detail'])" -ForegroundColor Gray
                    Write-Host "  THIS CANNOT BE UNDONE." -ForegroundColor Red
                    $confirm = Read-Host "  Are you absolutely sure? [Y/N]"
                    if ($confirm.Trim().ToUpper() -eq 'Y') {
                        Invoke-RemovePackage -Source $source -Tool $tool
                    } else {
                        Write-Host "  Cancelled." -ForegroundColor Gray
                    }
                } else {
                    Write-Host "  Invalid number." -ForegroundColor Red
                }
            }
            '3' {
                $idx = Read-Host "  Enter finding number to view"
                $idxInt = 0
                if ([int]::TryParse($idx, [ref]$idxInt) -and $idxInt -ge 1 -and $idxInt -le $Findings.Count) {
                    $finding = $Findings[$idxInt - 1]
                    Write-Host "`n  === FULL DETAILS ===" -ForegroundColor Cyan
                    foreach ($key in $finding.Keys) {
                        Write-Host "  $key : $($finding[$key])" -ForegroundColor White
                    }
                } else {
                    Write-Host "  Invalid number." -ForegroundColor Red
                }
            }
            '4' {
                $inSubMenu = $false
            }
            '5' {
                Export-Report -Findings $Findings -ScanType $ScanType
            }
            default {
                Write-Host "  Invalid choice. Enter 1-5." -ForegroundColor Red
            }
        }
    }
}

#endregion

#region --- Settings Menu ---

function Show-SettingsMenu {
    param([hashtable]$Config)
    $inSettings = $true
    while ($inSettings) {
        Clear-Host
        Write-Host '╔══════════════════════════════════════════════════════════╗' -ForegroundColor Magenta
        Write-Host '║           SAFETY KING — Settings & Options              ║' -ForegroundColor Magenta
        Write-Host '╚══════════════════════════════════════════════════════════╝' -ForegroundColor Magenta
        Write-Host ''
        Write-Host "  Package Managers:" -ForegroundColor Cyan
        Write-Host "   1. Winget   : $(if ($Config.PackageManagers.Winget) { '[ON] ' } else { '[OFF]' })" -ForegroundColor White
        Write-Host "   2. Choco    : $(if ($Config.PackageManagers.Choco)  { '[ON] ' } else { '[OFF]' })" -ForegroundColor White
        Write-Host "   3. Scoop    : $(if ($Config.PackageManagers.Scoop)  { '[ON] ' } else { '[OFF]' })" -ForegroundColor White
        Write-Host ''
        Write-Host "  Cross-Platform Tools:" -ForegroundColor Cyan
        Write-Host "   4. npm/Node : $(if ($Config.CrossPlatform.Npm)   { '[ON] ' } else { '[OFF]' })" -ForegroundColor White
        Write-Host "   5. pip/Python: $(if ($Config.CrossPlatform.Pip)  { '[ON] ' } else { '[OFF]' })" -ForegroundColor White
        Write-Host "   6. cargo/Rust: $(if ($Config.CrossPlatform.Cargo){ '[ON] ' } else { '[OFF]' })" -ForegroundColor White
        Write-Host ''
        Write-Host "  Options:" -ForegroundColor Cyan
        Write-Host "   7. Update Channel      : $($Config.UpdateChannel)" -ForegroundColor White
        Write-Host "   8. Report Output Path  : $($Config.ReportOutputPath)" -ForegroundColor White
        Write-Host "   9. Check WSL Mismatches: $(if ($Config.CheckWSLMismatches) { '[ON] ' } else { '[OFF]' })" -ForegroundColor White
        Write-Host "  10. Scan Depth          : $($Config.ScanDepth)" -ForegroundColor White
        Write-Host ''
        Write-Host "  11. Save and return to main menu" -ForegroundColor Green
        Write-Host "  12. Discard changes and return"   -ForegroundColor Yellow
        Write-Host ''

        $choice = Read-Host "  Enter choice [1-12]"
        switch ($choice.Trim()) {
            '1'  { $Config.PackageManagers.Winget = -not $Config.PackageManagers.Winget }
            '2'  { $Config.PackageManagers.Choco  = -not $Config.PackageManagers.Choco  }
            '3'  { $Config.PackageManagers.Scoop  = -not $Config.PackageManagers.Scoop  }
            '4'  { $Config.CrossPlatform.Npm      = -not $Config.CrossPlatform.Npm      }
            '5'  { $Config.CrossPlatform.Pip      = -not $Config.CrossPlatform.Pip      }
            '6'  { $Config.CrossPlatform.Cargo    = -not $Config.CrossPlatform.Cargo    }
            '7'  {
                Write-Host "  Current: $($Config.UpdateChannel)" -ForegroundColor Gray
                Write-Host "  Options: LTS, Stable, Latest" -ForegroundColor Gray
                $newChannel = Read-Host "  Enter update channel"
                if ($newChannel.Trim() -in @('LTS','Stable','Latest')) {
                    $Config.UpdateChannel = $newChannel.Trim()
                } else {
                    Write-Host "  Invalid. Must be LTS, Stable, or Latest." -ForegroundColor Red
                }
            }
            '8'  {
                Write-Host "  Current: $($Config.ReportOutputPath)" -ForegroundColor Gray
                $newPath = Read-Host "  Enter new report output path"
                if ($newPath.Trim() -ne '') {
                    if (-not (Test-Path $newPath.Trim())) {
                        $createIt = Read-Host "  Path does not exist. Create it? [Y/N]"
                        if ($createIt.Trim().ToUpper() -eq 'Y') {
                            New-Item -ItemType Directory -Path $newPath.Trim() -Force | Out-Null
                            $Config.ReportOutputPath = $newPath.Trim()
                        }
                    } else {
                        $Config.ReportOutputPath = $newPath.Trim()
                    }
                }
            }
            '9'  { $Config.CheckWSLMismatches = -not $Config.CheckWSLMismatches }
            '10' {
                Write-Host "  Current: $($Config.ScanDepth)" -ForegroundColor Gray
                Write-Host "  Options: Quick, Deep" -ForegroundColor Gray
                $newDepth = Read-Host "  Enter scan depth"
                if ($newDepth.Trim() -in @('Quick','Deep')) {
                    $Config.ScanDepth = $newDepth.Trim()
                } else {
                    Write-Host "  Invalid. Must be Quick or Deep." -ForegroundColor Red
                }
            }
            '11' {
                Save-Config -Config $Config
                Write-Host "  Settings saved." -ForegroundColor Green
                $inSettings = $false
            }
            '12' {
                $inSettings = $false
            }
            default {
                Write-Host "  Invalid choice. Enter 1-12." -ForegroundColor Red
            }
        }
    }
    return $Config
}

#endregion

#region --- Update Package Interactive ---

function Show-UpdateMenu {
    param([hashtable]$Config)
    Clear-Host
    Write-Host '  UPDATE A PACKAGE OR TOOL' -ForegroundColor Cyan
    Write-Host '  ─────────────────────────────────────' -ForegroundColor DarkGray
    Write-Host "  Source options: winget, choco, scoop, npm-global, pip, rustup, powershell" -ForegroundColor Gray
    Write-Host ''
    $source = Read-Host "  Enter source"
    $tool   = Read-Host "  Enter tool/package name (or 'all' to update all from this source)"
    Write-Host ''

    if ($tool.Trim().ToLower() -eq 'all') {
        $confirm = Read-Host "  Update ALL packages from '$source'? [Y/N]"
        if ($confirm.Trim().ToUpper() -ne 'Y') {
            Write-Host "  Cancelled." -ForegroundColor Gray
            return
        }
        switch ($source.Trim().ToLower()) {
            'winget' { winget upgrade --all }
            'choco'  { choco upgrade all -y }
            'scoop'  { scoop update '*' }
            'npm-global' { npm update -g }
            'pip'    { pip list --outdated --format=json | ConvertFrom-Json | ForEach-Object { pip install --upgrade $_.name } }
            'rustup' { rustup update }
            default  { Write-Host "  Unknown source '$source'." -ForegroundColor Red }
        }
    } else {
        $confirm = Read-Host "  Update '$($tool.Trim())' from '$($source.Trim())'? [Y/N]"
        if ($confirm.Trim().ToUpper() -ne 'Y') {
            Write-Host "  Cancelled." -ForegroundColor Gray
            return
        }
        Invoke-UpdatePackage -Source $source.Trim() -Tool $tool.Trim()
    }
}

#endregion

#region --- Main Menu ---

function Show-MainMenu {
    param([hashtable]$Config)
    $running = $true
    while ($running) {
        Clear-Host
        Write-Host '╔══════════════════════════════════════════════════════════╗' -ForegroundColor Green
        Write-Host '║              SAFETY KING v1.0.0 — Windows               ║' -ForegroundColor Green
        Write-Host '║         Environment Health & Conflict Resolution         ║' -ForegroundColor Green
        Write-Host '╚══════════════════════════════════════════════════════════╝' -ForegroundColor Green
        Write-Host ''
        Write-Host '   1.  Scan for duplicate tool versions'        -ForegroundColor White
        Write-Host '   2.  Scan for outdated versions'              -ForegroundColor White
        Write-Host '   3.  Update a package or tool'                -ForegroundColor White
        Write-Host '   4.  Scan for PATH conflicts'                 -ForegroundColor White
        Write-Host '   5.  Scan for WSL bleed'                     -ForegroundColor White
        Write-Host '   6.  Scan for unverified / unsigned packages' -ForegroundColor White
        Write-Host '   7.  Scan for version locks blocking uninstalls' -ForegroundColor White
        Write-Host '   8.  Scan for global vs local install conflicts' -ForegroundColor White
        Write-Host '   9.  Scan for vulnerabilities'               -ForegroundColor White
        Write-Host '  10.  Scan for cross-environment mismatches (Windows vs WSL)' -ForegroundColor White
        Write-Host '  11.  Resolve flagged conflicts (run all scans)' -ForegroundColor White
        Write-Host '  12.  Export full report'                     -ForegroundColor White
        Write-Host '  13.  Settings & Options'                     -ForegroundColor Cyan
        Write-Host '  14.  Exit'                                   -ForegroundColor Red
        Write-Host ''
        Write-Host '  NOTE: Nothing runs without your explicit Y/N confirmation.' -ForegroundColor DarkGray
        Write-Host ''

        $choice = Read-Host "  Enter choice [1-14]"
        switch ($choice.Trim()) {
            '1' {
                $confirm = Read-Host "`n  Run duplicate version scan? [Y/N]"
                if ($confirm.Trim().ToUpper() -eq 'Y') {
                    $findings = Invoke-ScanDuplicateVersions -Config $Config
                    Show-FindingsSubMenu -Findings $findings -ScanType 'DuplicateVersions'
                }
            }
            '2' {
                $confirm = Read-Host "`n  Run outdated version scan? [Y/N]"
                if ($confirm.Trim().ToUpper() -eq 'Y') {
                    $findings = Invoke-ScanOutdatedVersions -Config $Config
                    Show-FindingsSubMenu -Findings $findings -ScanType 'OutdatedVersions'
                }
            }
            '3' {
                Show-UpdateMenu -Config $Config
                Read-Host "`n  Press ENTER to return to main menu"
            }
            '4' {
                $confirm = Read-Host "`n  Run PATH conflict scan? [Y/N]"
                if ($confirm.Trim().ToUpper() -eq 'Y') {
                    $findings = Invoke-ScanPathConflicts
                    Show-FindingsSubMenu -Findings $findings -ScanType 'PathConflicts'
                }
            }
            '5' {
                $confirm = Read-Host "`n  Run WSL bleed scan? [Y/N]"
                if ($confirm.Trim().ToUpper() -eq 'Y') {
                    $findings = Invoke-ScanWSLBleed
                    Show-FindingsSubMenu -Findings $findings -ScanType 'WSLBleed'
                }
            }
            '6' {
                $confirm = Read-Host "`n  Run unverified package scan? [Y/N]"
                if ($confirm.Trim().ToUpper() -eq 'Y') {
                    $findings = Invoke-ScanUnverifiedPackages -Config $Config
                    Show-FindingsSubMenu -Findings $findings -ScanType 'UnverifiedPackages'
                }
            }
            '7' {
                $confirm = Read-Host "`n  Run version lock scan? [Y/N]"
                if ($confirm.Trim().ToUpper() -eq 'Y') {
                    $findings = Invoke-ScanVersionLocks -Config $Config
                    Show-FindingsSubMenu -Findings $findings -ScanType 'VersionLocks'
                }
            }
            '8' {
                $confirm = Read-Host "`n  Run global vs local conflict scan? [Y/N]"
                if ($confirm.Trim().ToUpper() -eq 'Y') {
                    $findings = Invoke-ScanGlobalLocalConflicts -Config $Config
                    Show-FindingsSubMenu -Findings $findings -ScanType 'GlobalLocalConflicts'
                }
            }
            '9' {
                $confirm = Read-Host "`n  Run vulnerability scan? This may take a few minutes. [Y/N]"
                if ($confirm.Trim().ToUpper() -eq 'Y') {
                    $findings = Invoke-ScanVulnerabilities -Config $Config
                    Show-FindingsSubMenu -Findings $findings -ScanType 'Vulnerabilities'
                }
            }
            '10' {
                $confirm = Read-Host "`n  Run cross-environment mismatch scan (requires WSL)? [Y/N]"
                if ($confirm.Trim().ToUpper() -eq 'Y') {
                    $findings = Invoke-ScanCrossEnvironmentMismatches -Config $Config
                    Show-FindingsSubMenu -Findings $findings -ScanType 'CrossEnvMismatches'
                }
            }
            '11' {
                $confirm = Read-Host "`n  Run ALL scans and collect all findings? This may take several minutes. [Y/N]"
                if ($confirm.Trim().ToUpper() -eq 'Y') {
                    $allFindings = [System.Collections.Generic.List[hashtable]]::new()
                    Write-Host "`n  Running all scans..." -ForegroundColor Cyan
                    $allFindings.AddRange((Invoke-ScanDuplicateVersions -Config $Config))
                    $allFindings.AddRange((Invoke-ScanOutdatedVersions -Config $Config))
                    $allFindings.AddRange((Invoke-ScanPathConflicts))
                    $allFindings.AddRange((Invoke-ScanWSLBleed))
                    $allFindings.AddRange((Invoke-ScanUnverifiedPackages -Config $Config))
                    $allFindings.AddRange((Invoke-ScanVersionLocks -Config $Config))
                    $allFindings.AddRange((Invoke-ScanGlobalLocalConflicts -Config $Config))
                    $allFindings.AddRange((Invoke-ScanVulnerabilities -Config $Config))
                    $allFindings.AddRange((Invoke-ScanCrossEnvironmentMismatches -Config $Config))
                    Show-FindingsSubMenu -Findings $allFindings -ScanType 'FullScan'
                }
            }
            '12' {
                $confirm = Read-Host "`n  Export a full report (runs all scans)? [Y/N]"
                if ($confirm.Trim().ToUpper() -eq 'Y') {
                    $allFindings = [System.Collections.Generic.List[hashtable]]::new()
                    $allFindings.AddRange((Invoke-ScanDuplicateVersions -Config $Config))
                    $allFindings.AddRange((Invoke-ScanOutdatedVersions -Config $Config))
                    $allFindings.AddRange((Invoke-ScanPathConflicts))
                    $allFindings.AddRange((Invoke-ScanWSLBleed))
                    $allFindings.AddRange((Invoke-ScanUnverifiedPackages -Config $Config))
                    $allFindings.AddRange((Invoke-ScanVersionLocks -Config $Config))
                    $allFindings.AddRange((Invoke-ScanGlobalLocalConflicts -Config $Config))
                    $allFindings.AddRange((Invoke-ScanVulnerabilities -Config $Config))
                    $allFindings.AddRange((Invoke-ScanCrossEnvironmentMismatches -Config $Config))
                    $reportPath = Export-Report -Findings $allFindings -ScanType 'FullReport'
                    Write-Host "`n  Report saved: $reportPath" -ForegroundColor Green
                    Read-Host "`n  Press ENTER to return to main menu"
                }
            }
            '13' {
                $Config = Show-SettingsMenu -Config $Config
            }
            '14' {
                $confirm = Read-Host "`n  Exit Safety King? [Y/N]"
                if ($confirm.Trim().ToUpper() -eq 'Y') {
                    Write-Host "`n  Goodbye." -ForegroundColor Green
                    $running = $false
                }
            }
            default {
                Write-Host "`n  Invalid choice. Enter 1-14." -ForegroundColor Red
                Start-Sleep -Seconds 1
            }
        }
    }
}

#endregion

#region --- Entry Point ---

try {
    $config = Load-Config
    Write-SafetyLog "Safety King started. pwsh $($PSVersionTable.PSVersion)" 'INFO'
    Show-MainMenu -Config $config
    Write-SafetyLog "Safety King exited cleanly." 'INFO'
} catch {
    Write-SafetyLog "Fatal error: $_" 'ERROR'
    Write-Host "`n[FATAL] Safety King encountered an unhandled error:" -ForegroundColor Red
    Write-Host "  $_" -ForegroundColor Red
    Write-Host "`n  Check logs at: $(Join-Path $env:APPDATA 'SafetyKing\logs')" -ForegroundColor Yellow
    exit 1
}

#endregion


# SIG # Begin signature block
# MIIJIgYJKoZIhvcNAQcCoIIJEzCCCQ8CAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCDpYDyCn+ekyLGn
# tUye5tAjc3DuRwLuAl3kMrH+pAQ2y6CCBWgwggVkMIIDTKADAgECAhBEeDXFXkLZ
# t0cghZwNYSKoMA0GCSqGSIb3DQEBCwUAMEoxCzAJBgNVBAYTAlVTMRcwFQYDVQQK
# DA5TYWdlIEF1ZGlvIExMQzEiMCAGA1UEAwwZQ29kZVNpZ25pbmctTGVvblNhZ2Ut
# MjAyNjAeFw0yNjAxMjIyMDA0MDBaFw0zMTAxMjIyMDEzNTdaMEoxCzAJBgNVBAYT
# AlVTMRcwFQYDVQQKDA5TYWdlIEF1ZGlvIExMQzEiMCAGA1UEAwwZQ29kZVNpZ25p
# bmctTGVvblNhZ2UtMjAyNjCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIB
# AMcu7LQCZudgwCWaCwG5dSjfZv2OOeZKsMCq2cw9ZgfvDaTooyXGkGANTNcsNIre
# ZMWdIbyiy2TtU2JJR0RLRDPEg7ADhqjwtmsovOXjKIpnfOi6+CkBNYw2ORvHq02o
# s3uObI2WBUY1v+fkNKdg6mKC6J6Qj9PR0P3w3AU2tN71lr76VGM4NpcZePqocUA9
# 6YHhVXQEJOVJ0cFIlOmrUEKFZCbHRX9wNEgmcoRQHR24+VvGlJAhK4ifLNL2SnXx
# b4737Iz/ylPd7ADYgZFqoVOde1gmQZl1D0VIckjQsbXNCGCk2k93r0+UaknJZChH
# t6cur64VGbUi2BBYvM6VR7hj/FRgLc0hfgbbpoZ0AI+4kBuDhJmRYkvfMbA55Rrv
# TNpXUjVgdn1jqaAAvjirpzpnO1RvaFVufFx6vgNLlw14LtSp2Sj+3Cl1Ds0skd8d
# qrcUpdDLtqfpXr3i2CWwSKvxLx8L0EWi3pRuI6gzLKZoUO0qPaiVPF2Sp9E9EO2D
# N5P4YN8Q1dk4/GKPcPV5Vne8a09z1dGvb/JgurdTeOlY4+YnGVpOTHWtG0yCa1Qh
# h93xx8rRQMeB2cwZZcXH8WbXVA0SvTk2XXkihyNO0DzLojJ7i2m9v+ZyePxgHpCf
# HyGO/v6TUFow3Ut+qF/it7XPfDeC4aY3JP8IIqVSat+1AgMBAAGjRjBEMA4GA1Ud
# DwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDAzAdBgNVHQ4EFgQUh5bbscZ/
# fvFAOQPerqajpP4jNekwDQYJKoZIhvcNAQELBQADggIBACvUVDxtyUtuRBbTzfaY
# VPFXKygu5B24PufkHNduzQruJiAQkRX6pGEnajyO2tlDONTYpziGm6zQKS5tNaRG
# tkFhXYSmIGn35uNm+Lnzuu9ITx1RqBJm19J7xVmlWK3RZ846KX/MsSkSKosfNPtU
# 68wFvBZBnkac8VW0rIjDKpw+JAamBIf+RTwXGJigKK2rf6R5tHQsQOK0nI16xZRc
# heT+LdtWG+mxxM8hI3sHbV0vmEZUghp7oz/GcUA6Z4jJXS8iC1Tp6rDSmiUBN5Da
# wZa4UcO5bY1jEo1+2VJMLX3z4UxoczJkyMr+iEDcWSyu0Z12o90KPu5y3gNYem6J
# JAddpD7GSxfD1b6gebTlBtMnfnKg1wclFoKmXaAlwQxoEaZE1MsKsDkRdmBYtHmv
# zEEZ7dY04Ykl8d12RDsVDRKhopZsitFYRdIdcAKM5DzMxVPwdsrNbu+1uuSOHWMp
# 9d+CvLS9i4NWoTJpzh9eIaZyHyBQb3Fr14Sp9SqlbdUgHLHdHjCVvEAtVQQcWwhe
# RmRKKNj+SO69hXHEM/MXeZhLTsAIXaNvha32lARl9KXEabJ8OA/Or4c/7gv7xJIw
# +qvuscBwejfU9EQWB+jiwsQyvv3AVVyiC+BJIj1VBnbj/My2IMHjb6C+DFcsOAKu
# sJimNJIzkAqUMp9jITdaR09eMYIDEDCCAwwCAQEwXjBKMQswCQYDVQQGEwJVUzEX
# MBUGA1UECgwOU2FnZSBBdWRpbyBMTEMxIjAgBgNVBAMMGUNvZGVTaWduaW5nLUxl
# b25TYWdlLTIwMjYCEER4NcVeQtm3RyCFnA1hIqgwDQYJYIZIAWUDBAIBBQCggYQw
# GAYKKwYBBAGCNwIBDDEKMAigAoAAoQKAADAZBgkqhkiG9w0BCQMxDAYKKwYBBAGC
# NwIBBDAcBgorBgEEAYI3AgELMQ4wDAYKKwYBBAGCNwIBFTAvBgkqhkiG9w0BCQQx
# IgQgttCJDuDqQKo16O2jcSucI8gQScppdX5UAr6ebX9US4wwDQYJKoZIhvcNAQEB
# BQAEggIAvVFyRJBVj7SdvhldIV7LU3w0rF/x7diDsPB/ux49t/wZOwblQlBWwj/l
# p47fR/MmAPkBBYKsdgCkYiPK0eW/nXYOcRlYS7jZNEEtpx97fK7XgicYrOULAE3j
# /jKCbNH4U9lxiB1/ilBxPnpqcu9hk9sM2TqEPl8rEcAuAn7+eQwW5nfqS5+Ejwi/
# 0mt6gz8ADTtY1tYX0NbQnvah+6S6sVi4lvZIP/G3sTNcO8wihLc6tjeEuSgYyHdY
# Ajc8tYq92/kGMp2u+gCfg0zcwPeSf1FIMXtSBrjChkej/ECqv0B5M3g1PtcnGi1V
# GagEdfl0RB1Y1z9dK0wMYFWN3mRM/tBQWPcwfHvzWrw0v3e8PLqZjr0/+hgnXhuW
# yULtCZbnDfJdzEfpItPFhxjFxymjKef2jn+E+IN/jhsQS+9CEZquR8jr64RRJkEu
# 8aVngdP326PIQ77xzkkW3sAvZMRjkjbvYJJfGlTXsEtIbpIUvWx6zIbcoBYrkU8f
# WES3WQup1HVr1UGPfN75xC46sfpT22I4o0Yl0b+QFPMZg9HAg8Xh9vWjfV7Gr1MY
# S8xnuUiqcKRpklvfnAukiXmYQp0SfuEyT0OUBRSxcASXwqMXPs+GoEi6E+WjdUll
# pmCWH57YuMVxJpL72DBhftsgLot9QR3sBNSj1sUpdkY3yKO5WlM=
# SIG # End signature block
