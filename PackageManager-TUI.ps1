<#
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2026 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-06-22 13:10:31
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  D7163B89EF85FE52DE14148276EF319A99322891463E984736E32FE8D2710050
SHA-512:  A5C0F29A687AA2746CBD9FBB23FC8643E49911CB0FC8B711635CB1549A7E3C82E50779190936DD36A4F8CB8317C433495C47AF9D2789EC792427B8678C94B3E5
MD5:      9622B69D6439AFD78A9AD8560C2A09BF
File Size: 98326 bytes

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
#requires -Version 7.0

<#
.SYNOPSIS
    Auto-scanning, tagging, flagging Package Manager TUI for PowerShell 7+.

.DESCRIPTION
    On launch you pick which package managers to scan. The script runs all scans
    automatically, tags every package as [UPDATE] [VULN] [CONFLICT] [REMOVE] [OK],
    shows flagged items in separate lists per manager, and lets you act on them
    individually or in bulk. Every manager also has a full manual command menu.
    Nothing runs without explicit Y/N confirmation. You never have to type a package name.

.EXAMPLE
    pwsh -File .\PackageManager-TUI.ps1

.NOTES
    Version:      3.0
    Date:         2026-03-26
    Requires:     PowerShell 7.0+
    Platform:     Windows primary — macOS/Linux supported where applicable
    Dependencies: pip-audit        — pip security scan
                  cargo-audit      — Rust security scan
                  cargo-outdated   — Rust outdated check
                  bundler-audit    — Ruby security scan
                  govulncheck      — Go security scan
                  npm-check-updates (ncu) — npm beyond-semver upgrades

.LINK
    https://pip.pypa.io
    https://docs.npmjs.com
    https://yarnpkg.com
    https://pnpm.io
    https://learn.microsoft.com/en-us/windows/package-manager/winget
    https://chocolatey.org
    https://brew.sh
    https://wiki.debian.org/apt
    https://doc.rust-lang.org/cargo
    https://rubygems.org
    https://go.dev/ref/mod
#>

[CmdletBinding()]
param()

# ══════════════════════════════════════════════════════════════════════════════
#  GLOBAL FLAG STORE
# ══════════════════════════════════════════════════════════════════════════════
$script:Flags   = [ordered]@{}
$script:Scanned = [ordered]@{}

# ══════════════════════════════════════════════════════════════════════════════
#  COLOUR ENGINE
# ══════════════════════════════════════════════════════════════════════════════
function CC([string]$c) {
    [Console]::ForegroundColor = switch ($c) {
        'Cyan'        { [ConsoleColor]::Cyan        }
        'Yellow'      { [ConsoleColor]::Yellow      }
        'Green'       { [ConsoleColor]::Green       }
        'Red'         { [ConsoleColor]::Red         }
        'Magenta'     { [ConsoleColor]::Magenta     }
        'White'       { [ConsoleColor]::White       }
        'Gray'        { [ConsoleColor]::Gray        }
        'Blue'        { [ConsoleColor]::Blue        }
        'DarkCyan'    { [ConsoleColor]::DarkCyan    }
        'DarkGreen'   { [ConsoleColor]::DarkGreen   }
        'DarkYellow'  { [ConsoleColor]::DarkYellow  }
        'DarkRed'     { [ConsoleColor]::DarkRed     }
        'DarkMagenta' { [ConsoleColor]::DarkMagenta }
        'DarkBlue'    { [ConsoleColor]::DarkBlue    }
        default       { [ConsoleColor]::White       }
    }
}
function RC { [Console]::ResetColor() }

function Tag-Color([string]$tag) {
    switch ($tag) {
        'UPDATE'   { CC 'Yellow'  }
        'VULN'     { CC 'Red'     }
        'CONFLICT' { CC 'Magenta' }
        'REMOVE'   { CC 'DarkRed' }
        'OK'       { CC 'Green'   }
        default    { CC 'Gray'    }
    }
}

# ══════════════════════════════════════════════════════════════════════════════
#  SHARED UI HELPERS
# ══════════════════════════════════════════════════════════════════════════════
function Write-ThinDivider([string]$color = 'Gray') {
    CC $color
    Write-Host ("  " + ("─" * 72))
    RC
}

function Write-SectionBox([string]$Title, [string]$Color = 'Cyan') {
    $pad = 68
    CC $Color
    Write-Host "  ╔$("═" * $pad)╗"
    Write-Host ("  ║  {0,-$($pad-2)}║" -f $Title)
    Write-Host "  ╚$("═" * $pad)╝"
    RC
}

function Confirm-Action([string]$Msg) {
    CC 'Yellow'
    Write-Host -NoNewline "`n  ⚠  $Msg"
    RC
    Write-Host -NoNewline " [Y/N]: "
    return (Read-Host) -match '^[Yy]$'
}

function Invoke-Cmd([string]$Cmd) {
    Write-Host ""
    CC 'DarkCyan'
    Write-Host "  ┌─ Executing ──────────────────────────────────────────────────────────"
    Write-Host "  │  $Cmd"
    Write-Host "  └─────────────────────────────────────────────────────────────────────"
    RC
    Write-Host ""
    try { Invoke-Expression $Cmd }
    catch {
        CC 'Red'
        Write-Host "`n  ✖ ERROR: $_"
        RC
    }
    Write-Host ""
    CC 'Gray'; Write-Host "  Press any key to continue..."; RC
    [void][Console]::ReadKey($true)
}

function Read-MenuChoice([int]$Max) {
    CC 'Cyan'
    Write-Host -NoNewline "`n  ❯ Choice: "
    RC
    $r = Read-Host
    if ($r -match '^\d+$' -and [int]$r -ge 0 -and [int]$r -le $Max) { return [int]$r }
    return -1
}

function Show-MenuOptions([string[]]$Options, [string]$Color = 'White') {
    $i = 1
    foreach ($o in $Options) {
        CC $Color
        Write-Host -NoNewline "    [$i]"
        RC
        Write-Host "  $o"
        $i++
    }
    CC 'Gray'
    Write-Host "    [0]  Back"
    RC
}

function Test-Tool([string]$Name) {
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

# ══════════════════════════════════════════════════════════════════════════════
#  MAIN BANNER
# ══════════════════════════════════════════════════════════════════════════════
function Show-Banner {
    Clear-Host
    CC 'DarkCyan'
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════════════════════════════════╗"
    RC
    CC 'Cyan'
    Write-Host "  ║  ██████╗ ██╗  ██████╗ ███╗   ███╗ ██████╗ ██████╗  ████████╗██╗   ║"
    Write-Host "  ║  ██╔══██╗██║ ██╔════╝ ████╗ ████║██╔════╝ ██╔══██╗    ██╔══╝██║   ║"
    Write-Host "  ║  ██████╔╝██║ ██║      ██╔████╔██║██║  ███╗██████╔╝    ██║   ██║   ║"
    Write-Host "  ║  ██╔═══╝ ██║ ██║      ██║╚██╔╝██║██║   ██║██╔══██╗    ██║   ██║   ║"
    Write-Host "  ║  ██║     ██║ ╚██████╗ ██║ ╚═╝ ██║╚██████╔╝██║  ██║    ██║   ██║   ║"
    Write-Host "  ║  ╚═╝     ╚═╝  ╚═════╝ ╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝   ║"
    CC 'DarkCyan'
    Write-Host "  ╠══════════════════════════════════════════════════════════════════════╣"
    CC 'Yellow'
    Write-Host "  ║       AUTO-SCAN  •  TAG  •  FLAG  •  ACT    |   PowerShell 7+      ║"
    CC 'DarkCyan'
    Write-Host "  ║             pip • npm • yarn • pnpm • winget • choco               ║"
    Write-Host "  ║               brew • apt • cargo • gem • go                        ║"
    CC 'Gray'
    Write-Host "  ║                Nothing executes without Y/N                         ║"
    CC 'DarkCyan'
    Write-Host "  ╚══════════════════════════════════════════════════════════════════════╝"
    RC
    Write-Host ""
}

# ══════════════════════════════════════════════════════════════════════════════
#  PER-MANAGER ASCII ART BANNERS
# ══════════════════════════════════════════════════════════════════════════════
function Show-PipArt {
    CC 'Yellow'
    Write-Host ""
    Write-Host "       ██████╗ ██╗██████╗      Python Package Installer"
    Write-Host "       ██╔══██╗██║██╔══██╗     pip 26.0.1"
    Write-Host "       ██████╔╝██║██████╔╝"
    Write-Host "       ██╔═══╝ ██║██╔═══╝"
    Write-Host "       ██║     ██║██║"
    Write-Host "       ╚═╝     ╚═╝╚═╝"
    RC
}

function Show-NpmArt {
    CC 'Red'
    Write-Host ""
    Write-Host "       ███╗   ██╗██████╗ ███╗   ███╗     Node Package Manager"
    Write-Host "       ████╗  ██║██╔══██╗████╗ ████║     v11.x"
    Write-Host "       ██╔██╗ ██║██████╔╝██╔████╔██║"
    Write-Host "       ██║╚██╗██║██╔═══╝ ██║╚██╔╝██║"
    Write-Host "       ██║ ╚████║██║     ██║ ╚═╝ ██║"
    Write-Host "       ╚═╝  ╚═══╝╚═╝     ╚═╝     ╚═╝"
    RC
}

function Show-YarnArt {
    CC 'Blue'
    Write-Host ""
    Write-Host "       ██╗   ██╗ █████╗ ██████╗ ███╗   ██╗     v4 Berry"
    Write-Host "       ╚██╗ ██╔╝██╔══██╗██╔══██╗████╗  ██║     Node.js"
    Write-Host "        ╚████╔╝ ███████║██████╔╝██╔██╗ ██║"
    Write-Host "         ╚██╔╝  ██╔══██║██╔══██╗██║╚██╗██║"
    Write-Host "          ██║   ██║  ██║██║  ██║██║ ╚████║"
    Write-Host "          ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝"
    RC
}

function Show-PnpmArt {
    CC 'Yellow'
    Write-Host ""
    Write-Host "       ██████╗ ███╗   ██╗██████╗ ███╗   ███╗    Fast"
    Write-Host "       ██╔══██╗████╗  ██║██╔══██╗████╗ ████║    Disk-Efficient"
    Write-Host "       ██████╔╝██╔██╗ ██║██████╔╝██╔████╔██║    Monorepo-Ready"
    Write-Host "       ██╔═══╝ ██║╚██╗██║██╔═══╝ ██║╚██╔╝██║"
    Write-Host "       ██║     ██║ ╚████║██║     ██║ ╚═╝ ██║"
    Write-Host "       ╚═╝     ╚═╝  ╚═══╝╚═╝     ╚═╝     ╚═╝"
    RC
}

function Show-WingetArt {
    CC 'Cyan'
    Write-Host ""
    Write-Host "       ██╗    ██╗██╗███╗   ██╗ ██████╗ ███████╗████████╗"
    Write-Host "       ██║    ██║██║████╗  ██║██╔════╝ ██╔════╝╚══██╔══╝"
    Write-Host "       ██║ █╗ ██║██║██╔██╗ ██║██║  ███╗█████╗     ██║"
    Write-Host "       ██║███╗██║██║██║╚██╗██║██║   ██║██╔══╝     ██║"
    Write-Host "       ╚███╔███╔╝██║██║ ╚████║╚██████╔╝███████╗   ██║"
    Write-Host "        ╚══╝╚══╝ ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝   ╚═╝    Windows Package Manager"
    RC
}

function Show-ChocoArt {
    CC 'DarkYellow'
    Write-Host ""
    Write-Host "        ██████╗██╗  ██╗ ██████╗  ██████╗ ██████╗"
    Write-Host "       ██╔════╝██║  ██║██╔═══██╗██╔════╝██╔═══██╗"
    Write-Host "       ██║     ███████║██║   ██║██║     ██║   ██║    Chocolatey"
    Write-Host "       ██║     ██╔══██║██║   ██║██║     ██║   ██║    Windows"
    Write-Host "       ╚██████╗██║  ██║╚██████╔╝╚██████╗╚██████╔╝"
    Write-Host "        ╚═════╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═════╝"
    RC
}

function Show-BrewArt {
    CC 'Green'
    Write-Host ""
    Write-Host "       ██████╗ ██████╗ ███████╗██╗    ██╗"
    Write-Host "       ██╔══██╗██╔══██╗██╔════╝██║    ██║"
    Write-Host "       ██████╔╝██████╔╝█████╗  ██║ █╗ ██║    Homebrew"
    Write-Host "       ██╔══██╗██╔══██╗██╔══╝  ██║███╗██║    macOS / Linux"
    Write-Host "       ██████╔╝██║  ██║███████╗╚███╔███╔╝"
    Write-Host "       ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚══╝╚══╝"
    RC
}

function Show-AptArt {
    CC 'Magenta'
    Write-Host ""
    Write-Host "        █████╗ ██████╗ ████████╗"
    Write-Host "       ██╔══██╗██╔══██╗╚══██╔══╝    Advanced Package Tool"
    Write-Host "       ███████║██████╔╝   ██║        Debian / Ubuntu"
    Write-Host "       ██╔══██║██╔═══╝    ██║"
    Write-Host "       ██║  ██║██║        ██║"
    Write-Host "       ╚═╝  ╚═╝╚═╝        ╚═╝"
    RC
}

function Show-CargoArt {
    CC 'Red'
    Write-Host ""
    Write-Host "        ██████╗ █████╗ ██████╗  ██████╗  ██████╗"
    Write-Host "       ██╔════╝██╔══██╗██╔══██╗██╔════╝ ██╔═══██╗"
    Write-Host "       ██║     ███████║██████╔╝██║  ███╗██║   ██║    Rust"
    Write-Host "       ██║     ██╔══██║██╔══██╗██║   ██║██║   ██║    Package Manager"
    Write-Host "       ╚██████╗██║  ██║██║  ██║╚██████╔╝╚██████╔╝"
    Write-Host "        ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝"
    RC
}

function Show-GemArt {
    CC 'Magenta'
    Write-Host ""
    Write-Host "        ██████╗ ███████╗███╗   ███╗"
    Write-Host "       ██╔════╝ ██╔════╝████╗ ████║    RubyGems"
    Write-Host "       ██║  ███╗█████╗  ██╔████╔██║    Bundler"
    Write-Host "       ██║   ██║██╔══╝  ██║╚██╔╝██║"
    Write-Host "       ╚██████╔╝███████╗██║ ╚═╝ ██║"
    Write-Host "        ╚═════╝ ╚══════╝╚═╝     ╚═╝"
    RC
}

function Show-GoArt {
    CC 'Cyan'
    Write-Host ""
    Write-Host "        ██████╗  ██████╗     ███╗   ███╗ ██████╗ ██████╗ ███████╗"
    Write-Host "       ██╔════╝ ██╔═══██╗    ████╗ ████║██╔═══██╗██╔══██╗██╔════╝"
    Write-Host "       ██║  ███╗██║   ██║    ██╔████╔██║██║   ██║██║  ██║███████╗"
    Write-Host "       ██║   ██║██║   ██║    ██║╚██╔╝██║██║   ██║██║  ██║╚════██║"
    Write-Host "       ╚██████╔╝╚██████╔╝    ██║ ╚═╝ ██║╚██████╔╝██████╔╝███████║"
    Write-Host "        ╚═════╝  ╚═════╝     ╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝"
    RC
}

# ══════════════════════════════════════════════════════════════════════════════
#  FLAG STORE HELPERS
# ══════════════════════════════════════════════════════════════════════════════
function Add-Flag([string]$Manager,[string]$Name,[string]$Tag,
                  [string]$Current,[string]$Latest,[string]$Reason) {
    if (-not $script:Flags.Contains($Manager)) {
        $script:Flags[$Manager] = [System.Collections.Generic.List[hashtable]]::new()
    }
    $existing = $script:Flags[$Manager] | Where-Object { $_.Name -eq $Name }
    if ($existing) {
        $priority = @{ 'VULN'=4;'CONFLICT'=3;'REMOVE'=2;'UPDATE'=1;'OK'=0 }
        if ($priority[$Tag] -gt $priority[$existing.Tag]) {
            $existing.Tag    = $Tag
            $existing.Reason = "$($existing.Reason) | $Reason"
            if ($Latest)  { $existing.Latest  = $Latest  }
            if ($Current) { $existing.Current = $Current }
        }
        return
    }
    $script:Flags[$Manager].Add(@{
        Name    = $Name
        Tag     = $Tag
        Current = if ($Current) { $Current } else { '-' }
        Latest  = if ($Latest)  { $Latest  } else { '-' }
        Reason  = if ($Reason)  { $Reason  } else { ''  }
    })
}

# ══════════════════════════════════════════════════════════════════════════════
#  SCANNERS
# ══════════════════════════════════════════════════════════════════════════════
function Scan-Pip {
    if (-not (Test-Tool 'pip')) { Write-Host "  pip not found"; return }
    $script:Flags['pip'] = [System.Collections.Generic.List[hashtable]]::new()
    try {
        pip list --outdated --format=json 2>$null | ConvertFrom-Json |
          ForEach-Object { Add-Flag 'pip' $_.name 'UPDATE' $_.version $_.latest_version 'outdated' }
    } catch {}
    try {
        pip check 2>&1 | ForEach-Object {
            if ($_ -match '^(\S+)\s') { Add-Flag 'pip' $Matches[1] 'CONFLICT' '' '' $_ }
        }
    } catch {}
    if (Test-Tool 'pip-audit') {
        try {
            (pip-audit --format=json 2>$null | ConvertFrom-Json).dependencies |
              Where-Object { $_.vulns.Count -gt 0 } | ForEach-Object {
                $ids = ($_.vulns | ForEach-Object { $_.id }) -join ','
                Add-Flag 'pip' $_.name 'VULN' $_.version '' "CVE: $ids"
              }
        } catch {}
    }
    $script:Scanned['pip'] = $true
}

function Scan-Npm {
    if (-not (Test-Tool 'npm')) { Write-Host "  npm not found"; return }
    $script:Flags['npm'] = [System.Collections.Generic.List[hashtable]]::new()
    try {
        $raw = npm outdated --json 2>$null | ConvertFrom-Json -AsHashtable
        if ($raw) { foreach ($k in $raw.Keys) { Add-Flag 'npm' $k 'UPDATE' $raw[$k].current $raw[$k].latest 'outdated' } }
    } catch {}
    try {
        $a = npm audit --json 2>$null | ConvertFrom-Json
        if ($a.vulnerabilities) {
            ($a.vulnerabilities | Get-Member -MemberType NoteProperty).Name | ForEach-Object {
                Add-Flag 'npm' $_ 'VULN' '' '' "severity: $($a.vulnerabilities.$_.severity)"
            }
        }
    } catch {}
    $script:Scanned['npm'] = $true
}

function Scan-Yarn {
    if (-not (Test-Tool 'yarn')) { Write-Host "  yarn not found"; return }
    $script:Flags['yarn'] = [System.Collections.Generic.List[hashtable]]::new()
    try {
        yarn outdated --json 2>$null | ForEach-Object {
            try {
                $obj = $_ | ConvertFrom-Json
                if ($obj.type -eq 'table') {
                    $obj.data.body | ForEach-Object {
                        if ($_[3] -and $_[1] -ne $_[3]) { Add-Flag 'yarn' $_[0] 'UPDATE' $_[1] $_[3] 'outdated' }
                    }
                }
            } catch {}
        }
    } catch {}
    try {
        yarn audit --json 2>$null | ForEach-Object {
            try {
                $obj = $_ | ConvertFrom-Json
                if ($obj.type -eq 'auditAdvisory') {
                    $a = $obj.data.advisory
                    Add-Flag 'yarn' $a.module_name 'VULN' '' '' "severity: $($a.severity)"
                }
            } catch {}
        }
    } catch {}
    $script:Scanned['yarn'] = $true
}

function Scan-Pnpm {
    if (-not (Test-Tool 'pnpm')) { Write-Host "  pnpm not found"; return }
    $script:Flags['pnpm'] = [System.Collections.Generic.List[hashtable]]::new()
    try {
        $raw = pnpm outdated --format json 2>$null | ConvertFrom-Json -AsHashtable
        if ($raw) { foreach ($k in $raw.Keys) { Add-Flag 'pnpm' $k 'UPDATE' $raw[$k].current $raw[$k].latest 'outdated' } }
    } catch {}
    try {
        $a = pnpm audit --json 2>$null | ConvertFrom-Json
        if ($a.vulnerabilities) {
            ($a.vulnerabilities | Get-Member -MemberType NoteProperty).Name | ForEach-Object {
                Add-Flag 'pnpm' $_ 'VULN' '' '' "severity: $($a.vulnerabilities.$_.severity)"
            }
        }
    } catch {}
    $script:Scanned['pnpm'] = $true
}

function Scan-Winget {
    if (-not (Test-Tool 'winget')) { Write-Host "  winget not found"; return }
    $script:Flags['winget'] = [System.Collections.Generic.List[hashtable]]::new()
    try {
        $inT = $false
        winget list --upgrade-available 2>$null | ForEach-Object {
            if ($_ -match '^-{3,}') { $inT = $true; return }
            if (-not $inT -or $_.Trim() -eq '') { return }
            $cols = $_ -split '\s{2,}'
            if ($cols.Count -ge 4) {
                Add-Flag 'winget' $cols[1].Trim() 'UPDATE' $cols[2].Trim() $cols[3].Trim() 'outdated'
            }
        }
    } catch {}
    $script:Scanned['winget'] = $true
}

function Scan-Choco {
    if (-not (Test-Tool 'choco')) { Write-Host "  choco not found"; return }
    $script:Flags['choco'] = [System.Collections.Generic.List[hashtable]]::new()
    try {
        choco outdated --limit-output 2>$null | ForEach-Object {
            $p = $_ -split '\|'
            if ($p.Count -ge 3) { Add-Flag 'choco' $p[0] 'UPDATE' $p[1] $p[2] 'outdated' }
        }
    } catch {}
    $script:Scanned['choco'] = $true
}

function Scan-Brew {
    if (-not (Test-Tool 'brew')) { Write-Host "  brew not found"; return }
    $script:Flags['brew'] = [System.Collections.Generic.List[hashtable]]::new()
    try {
        $raw = brew outdated --json=v2 2>$null | ConvertFrom-Json
        $raw.formulae | ForEach-Object { Add-Flag 'brew' $_.name 'UPDATE' ($_.installed_versions -join ',') $_.current_version 'outdated' }
        $raw.casks    | ForEach-Object { Add-Flag 'brew' $_.name 'UPDATE' $_.installed_versions $_.current_version 'outdated (cask)' }
    } catch {}
    $script:Scanned['brew'] = $true
}

function Scan-Apt {
    if (-not (Test-Tool 'apt')) { Write-Host "  apt not found"; return }
    $script:Flags['apt'] = [System.Collections.Generic.List[hashtable]]::new()
    try {
        apt list --upgradable 2>$null | ForEach-Object {
            if ($_ -match '^(.+?)\/\S+\s+(\S+)\s') { Add-Flag 'apt' $Matches[1] 'UPDATE' '' $Matches[2] 'upgradable' }
        }
    } catch {}
    $script:Scanned['apt'] = $true
}

function Scan-Cargo {
    if (-not (Test-Tool 'cargo')) { Write-Host "  cargo not found"; return }
    $script:Flags['cargo'] = [System.Collections.Generic.List[hashtable]]::new()
    if (Test-Tool 'cargo-outdated') {
        try {
            (cargo outdated --format json 2>$null | ConvertFrom-Json).dependencies |
              Where-Object { $_.latest -ne $_.project } |
              ForEach-Object { Add-Flag 'cargo' $_.name 'UPDATE' $_.project $_.latest 'outdated' }
        } catch {}
    }
    if (Test-Tool 'cargo-audit') {
        try {
            (cargo audit --json 2>$null | ConvertFrom-Json).vulnerabilities.list | ForEach-Object {
                Add-Flag 'cargo' $_.package.name 'VULN' $_.package.version '' "advisory: $($_.advisory.id)"
            }
        } catch {}
    }
    $script:Scanned['cargo'] = $true
}

function Scan-Gem {
    if (-not (Test-Tool 'gem')) { Write-Host "  gem not found"; return }
    $script:Flags['gem'] = [System.Collections.Generic.List[hashtable]]::new()
    try {
        gem outdated 2>$null | ForEach-Object {
            if ($_ -match '^(\S+)\s+\((\S+)\s+<\s+(\S+)\)') {
                Add-Flag 'gem' $Matches[1] 'UPDATE' $Matches[2] $Matches[3] 'outdated'
            }
        }
    } catch {}
    if (Test-Tool 'bundle') {
        try {
            bundle audit check --update 2>&1 | ForEach-Object {
                if ($_ -match 'Name:\s+(\S+)') { Add-Flag 'gem' $Matches[1] 'VULN' '' '' $_ }
            }
        } catch {}
    }
    $script:Scanned['gem'] = $true
}

function Scan-Go {
    if (-not (Test-Tool 'go')) { Write-Host "  go not found"; return }
    $script:Flags['go'] = [System.Collections.Generic.List[hashtable]]::new()
    try {
        $buf = ''
        go list -m -u -json all 2>$null | ForEach-Object {
            $buf += $_
            try {
                $obj = $buf | ConvertFrom-Json -ErrorAction Stop
                if ($obj.Update) { Add-Flag 'go' $obj.Path 'UPDATE' $obj.Version $obj.Update.Version 'outdated' }
                $buf = ''
            } catch {}
        }
    } catch {}
    if (Test-Tool 'govulncheck') {
        try {
            (govulncheck -json ./... 2>$null | ConvertFrom-Json).Vulns | ForEach-Object {
                $id = $_.OSV.id
                $_.Modules | ForEach-Object { Add-Flag 'go' $_.Path 'VULN' $_.FoundVersion '' "advisory: $id" }
            }
        } catch {}
    }
    $script:Scanned['go'] = $true
}

# ══════════════════════════════════════════════════════════════════════════════
#  SCAN PICKER
# ══════════════════════════════════════════════════════════════════════════════
function Start-ScanPicker {
    Show-Banner
    Write-SectionBox "SELECT MANAGERS TO SCAN" 'Cyan'
    Write-Host ""

    $all = [ordered]@{
        1  = @{ Label='pip          Python';                  Fn={ Scan-Pip    } }
        2  = @{ Label='npm          Node.js v11';             Fn={ Scan-Npm    } }
        3  = @{ Label='yarn         Node.js v4 Berry';        Fn={ Scan-Yarn   } }
        4  = @{ Label='pnpm         Node.js fast/disk-eff';   Fn={ Scan-Pnpm   } }
        5  = @{ Label='winget       Windows Package Manager'; Fn={ Scan-Winget } }
        6  = @{ Label='choco        Chocolatey Windows';      Fn={ Scan-Choco  } }
        7  = @{ Label='brew         Homebrew macOS/Linux';    Fn={ Scan-Brew   } }
        8  = @{ Label='apt          Debian/Ubuntu Linux';     Fn={ Scan-Apt    } }
        9  = @{ Label='cargo        Rust';                    Fn={ Scan-Cargo  } }
        10 = @{ Label='gem/bundler  Ruby';                    Fn={ Scan-Gem    } }
        11 = @{ Label='go modules   Go Language';             Fn={ Scan-Go     } }
    }

    foreach ($k in $all.Keys) {
        CC 'Cyan'; Write-Host -NoNewline "    [$k]"; RC
        Write-Host "  $($all[$k].Label)"
    }
    CC 'Yellow'; Write-Host "    [A]  All of the above"; RC
    Write-Host ""
    CC 'Cyan'; Write-Host -NoNewline "  Enter numbers separated by commas (e.g. 1,2,5) or A for all: "; RC
    $inp = Read-Host

    $chosen = @()
    if ($inp -match '^[Aa]$') {
        $chosen = $all.Keys
    } else {
        $chosen = $inp -split '[,\s]+' |
                  ForEach-Object { $_.Trim() } |
                  Where-Object   { $_ -match '^\d+$' -and $all.Contains([int]$_) } |
                  ForEach-Object { [int]$_ }
    }

    if ($chosen.Count -eq 0) {
        CC 'Red'; Write-Host "`n  No valid selection."; RC; Start-Sleep 2; return
    }

    Write-Host ""; Write-ThinDivider
    foreach ($k in $chosen) {
        $name = ($all[$k].Label -split '\s+')[0]
        CC 'Gray'; Write-Host -NoNewline "  Scanning "; CC 'White'; Write-Host -NoNewline $name; CC 'Gray'; Write-Host -NoNewline " ... "; RC
        try { & $all[$k].Fn } catch { CC 'Red'; Write-Host "FAILED: $_"; RC; continue }
        CC 'Green'; Write-Host "done"; RC
    }
    Write-ThinDivider
    CC 'Green'; Write-Host "`n  Scan complete. Press any key to view dashboard..."; RC
    [void][Console]::ReadKey($true)
}

# ══════════════════════════════════════════════════════════════════════════════
#  DASHBOARD
# ══════════════════════════════════════════════════════════════════════════════
function Show-Dashboard {
    if ($script:Flags.Count -eq 0) {
        CC 'Yellow'; Write-Host "  No scans run yet — select [1] Scan Packages to begin."; RC
        Write-Host ""; return
    }

    Write-SectionBox "SCAN DASHBOARD" 'DarkCyan'
    Write-Host ""

    $tagOrder = @('VULN','CONFLICT','REMOVE','UPDATE','OK')
    $totals   = @{}; foreach ($t in $tagOrder) { $totals[$t] = 0 }

    foreach ($mgr in $script:Flags.Keys) {
        $list   = @($script:Flags[$mgr])
        $counts = @{}; foreach ($t in $tagOrder) { $counts[$t] = 0 }
        foreach ($item in $list) {
            if ($counts.ContainsKey($item.Tag)) { $counts[$item.Tag]++ }
            if ($totals.ContainsKey($item.Tag)) { $totals[$item.Tag]++ }
        }
        CC 'White'; Write-Host -NoNewline ("    {0,-12}" -f $mgr.ToUpper()); RC
        $hasAny = $false
        foreach ($t in $tagOrder) {
            if ($counts[$t] -gt 0) {
                $hasAny = $true; Tag-Color $t
                Write-Host -NoNewline " [$t x$($counts[$t])]"; RC
            }
        }
        if (-not $hasAny) { CC 'Green'; Write-Host -NoNewline " [ALL CLEAN]"; RC }
        Write-Host ""
    }

    Write-Host ""; Write-ThinDivider
    CC 'White'; Write-Host -NoNewline "    TOTALS      "; RC
    foreach ($t in $tagOrder) {
        if ($totals[$t] -gt 0) { Tag-Color $t; Write-Host -NoNewline " [$t x$($totals[$t])]"; RC }
    }
    Write-Host ""; Write-ThinDivider; Write-Host ""
}

# ══════════════════════════════════════════════════════════════════════════════
#  FLAG LIST DISPLAY
# ══════════════════════════════════════════════════════════════════════════════
function Show-FlagList([string]$Manager) {
    $list = $script:Flags[$Manager]
    if (-not $list -or $list.Count -eq 0) {
        CC 'Green'; Write-Host "  No issues flagged for $Manager"; RC; return @()
    }
    CC 'DarkCyan'
    Write-Host ("  {0,-5} {1,-35} {2,-11} {3,-14} {4,-14} {5}" -f '#','Package','Tag','Current','Latest','Reason')
    Write-Host ("  " + ("─" * 95))
    RC
    $i = 1
    foreach ($item in $list) {
        CC 'Gray';  Write-Host -NoNewline ("  {0,-5}" -f "[$i]"); RC
        CC 'White'; Write-Host -NoNewline ("{0,-35}" -f $item.Name); RC
        Tag-Color $item.Tag; Write-Host -NoNewline ("{0,-11}" -f " [$($item.Tag)]"); RC
        CC 'Gray'
        Write-Host -NoNewline ("{0,-14}" -f $item.Current)
        Write-Host -NoNewline ("{0,-14}" -f $item.Latest)
        Write-Host $item.Reason
        RC; $i++
    }
    return $list
}

# ══════════════════════════════════════════════════════════════════════════════
#  COMMAND BUILDERS
# ══════════════════════════════════════════════════════════════════════════════
function Get-UpgradeCmd([string]$Mgr,[string]$Pkg) {
    switch ($Mgr) {
        'pip'    { "pip install -U $Pkg" }
        'npm'    { "npm install $Pkg@latest" }
        'yarn'   { "yarn upgrade $Pkg --latest" }
        'pnpm'   { "pnpm update $Pkg --latest" }
        'winget' { "winget upgrade --id $Pkg --silent --accept-package-agreements --accept-source-agreements" }
        'choco'  { "choco upgrade $Pkg -y" }
        'brew'   { "brew upgrade $Pkg" }
        'apt'    { "sudo apt install --only-upgrade $Pkg -y" }
        'cargo'  { "cargo update $Pkg" }
        'gem'    { "gem update $Pkg" }
        'go'     { "go get $Pkg@latest" }
    }
}

function Get-RemoveCmd([string]$Mgr,[string]$Pkg) {
    switch ($Mgr) {
        'pip'    { "pip uninstall $Pkg -y" }
        'npm'    { "npm uninstall $Pkg" }
        'yarn'   { "yarn remove $Pkg" }
        'pnpm'   { "pnpm remove $Pkg" }
        'winget' { "winget uninstall --id $Pkg --silent" }
        'choco'  { "choco uninstall $Pkg -y" }
        'brew'   { "brew uninstall $Pkg" }
        'apt'    { "sudo apt remove $Pkg -y" }
        'cargo'  { "cargo remove $Pkg" }
        'gem'    { "gem uninstall $Pkg -x" }
        'go'     { "go mod edit -droprequire $Pkg && go mod tidy" }
    }
}

function Get-ReinstallCmds([string]$Mgr,[string]$Pkg) {
    $remove  = Get-RemoveCmd $Mgr $Pkg
    $install = switch ($Mgr) {
        'pip'    { "pip install $Pkg" }
        'npm'    { "npm install $Pkg@latest" }
        'yarn'   { "yarn add $Pkg" }
        'pnpm'   { "pnpm add $Pkg" }
        'winget' { "winget install --id $Pkg --silent --accept-package-agreements --accept-source-agreements" }
        'choco'  { "choco install $Pkg -y" }
        'brew'   { "brew install $Pkg" }
        'apt'    { "sudo apt install $Pkg -y" }
        'cargo'  { "cargo add $Pkg" }
        'gem'    { "gem install $Pkg" }
        'go'     { "go get $Pkg@latest" }
    }
    return @($remove, $install)
}

# ══════════════════════════════════════════════════════════════════════════════
#  ACT ON FLAGS
# ══════════════════════════════════════════════════════════════════════════════
function Act-AllTagged([string]$Mgr,[string]$TagFilter,[string]$Action) {
    $list = @($script:Flags[$Mgr] | Where-Object { $_.Tag -eq $TagFilter })
    if ($list.Count -eq 0) { CC 'Gray'; Write-Host "  No [$TagFilter] items for $Mgr"; RC; Start-Sleep 1; return }
    $names = ($list | ForEach-Object { $_.Name }) -join ', '
    if (-not (Confirm-Action "$Action ALL [$TagFilter] in ${Mgr}: $names")) { return }
    foreach ($item in $list) {
        switch ($Action) {
            'UPDATE'    { Invoke-Cmd (Get-UpgradeCmd $Mgr $item.Name) }
            'REMOVE'    { Invoke-Cmd (Get-RemoveCmd  $Mgr $item.Name) }
            'REINSTALL' { foreach ($cmd in (Get-ReinstallCmds $Mgr $item.Name)) { Invoke-Cmd $cmd } }
        }
    }
}

function Act-Selected([string]$Mgr,[string]$Action) {
    Show-Banner
    CC 'Magenta'; Write-Host "  $Mgr — Select items to $Action`n"; RC
    $list = @(Show-FlagList $Mgr)
    if ($list.Count -eq 0) { Start-Sleep 2; return }

    Write-Host ""; CC 'Cyan'; Write-Host -NoNewline "  Numbers to $Action (comma-separated or A for all): "; RC
    $inp = Read-Host

    $chosen = @()
    if ($inp -match '^[Aa]$') {
        $chosen = 1..$list.Count
    } else {
        $chosen = $inp -split '[,\s]+' |
                  ForEach-Object { $_.Trim() } |
                  Where-Object   { $_ -match '^\d+$' } |
                  ForEach-Object { [int]$_ } |
                  Where-Object   { $_ -ge 1 -and $_ -le $list.Count }
    }

    foreach ($idx in $chosen) {
        $item = $list[$idx-1]
        switch ($Action) {
            'UPDATE' {
                if (Confirm-Action "Update $($item.Name) ($($item.Current) → $($item.Latest))?") {
                    Invoke-Cmd (Get-UpgradeCmd $Mgr $item.Name)
                }
            }
            'REMOVE' {
                if (Confirm-Action "Remove $($item.Name)?") { Invoke-Cmd (Get-RemoveCmd $Mgr $item.Name) }
            }
            'REINSTALL' {
                if (Confirm-Action "Reinstall $($item.Name)?") {
                    foreach ($cmd in (Get-ReinstallCmds $Mgr $item.Name)) { Invoke-Cmd $cmd }
                }
            }
        }
    }
}

function Act-AllManagers([string]$TagFilter,[string]$Action) {
    $found = $false
    foreach ($mgr in $script:Flags.Keys) {
        if (@($script:Flags[$mgr] | Where-Object { $_.Tag -eq $TagFilter }).Count -gt 0) {
            $found = $true; Act-AllTagged $mgr $TagFilter $Action
        }
    }
    if (-not $found) { CC 'Green'; Write-Host "`n  No [$TagFilter] items across any manager."; RC; Start-Sleep 2 }
}

# ══════════════════════════════════════════════════════════════════════════════
#  PER-MANAGER FLAG + ACTION SUBMENU
# ══════════════════════════════════════════════════════════════════════════════
function Menu-ManagerFlags([string]$Mgr,[scriptblock]$ArtFn) {
    do {
        Show-Banner; & $ArtFn; Write-Host ""; Show-FlagList $Mgr; Write-Host ""
        Write-ThinDivider
        CC 'White'
        Write-Host "    [1]  Update    — select packages to update"
        Write-Host "    [2]  Update    — ALL [UPDATE] tagged"
        Write-Host "    [3]  Remove    — select packages to remove"
        Write-Host "    [4]  Remove    — ALL [REMOVE] + [CONFLICT] tagged"
        Write-Host "    [5]  Reinstall — select packages"
        Write-Host "    [6]  Reinstall — ALL [VULN] tagged (remove then reinstall)"
        Write-Host "    [7]  Re-scan   — $Mgr only"
        Write-Host "    [8]  Manual commands menu"
        CC 'Gray'; Write-Host "    [0]  Back"; RC

        switch (Read-MenuChoice 8) {
            1 { Act-Selected  $Mgr 'UPDATE'    }
            2 { Act-AllTagged $Mgr 'UPDATE'    'UPDATE'    }
            3 { Act-Selected  $Mgr 'REMOVE'    }
            4 { Act-AllTagged $Mgr 'REMOVE'    'REMOVE';   Act-AllTagged $Mgr 'CONFLICT' 'REMOVE' }
            5 { Act-Selected  $Mgr 'REINSTALL' }
            6 { Act-AllTagged $Mgr 'VULN'      'REINSTALL' }
            7 {
                CC 'Gray'; Write-Host "  Re-scanning $Mgr..."; RC
                $script:Flags[$Mgr] = $null
                switch ($Mgr) {
                    'pip'  {Scan-Pip} 'npm'  {Scan-Npm} 'yarn'  {Scan-Yarn}  'pnpm'  {Scan-Pnpm}
                    'winget'{Scan-Winget}'choco'{Scan-Choco}'brew'{Scan-Brew}'apt'{Scan-Apt}
                    'cargo'{Scan-Cargo}'gem'  {Scan-Gem} 'go'   {Scan-Go}
                }
                CC 'Green'; Write-Host "  Done."; RC; Start-Sleep 1
            }
            8 {
                switch ($Mgr) {
                    'pip'  {Menu-Pip}    'npm'   {Menu-Npm}    'yarn' {Menu-Yarn}
                    'pnpm' {Menu-Pnpm}   'winget'{Menu-Winget} 'choco'{Menu-Choco}
                    'brew' {Menu-Brew}   'apt'   {Menu-Apt}    'cargo'{Menu-Cargo}
                    'gem'  {Menu-Gem}    'go'    {Menu-Go}
                }
            }
            0 { return }
        }
    } while ($true)
}

# ══════════════════════════════════════════════════════════════════════════════
#  MANUAL MENUS — every command, selections pulled live from the tool
# ══════════════════════════════════════════════════════════════════════════════

function Get-PipPackages([bool]$OutdatedOnly=$false) {
    try {
        if ($OutdatedOnly) {
            return @(pip list --outdated --format=json 2>$null | ConvertFrom-Json)
        } else {
            return @(pip list --format=json 2>$null | ConvertFrom-Json)
        }
    } catch { return @() }
}

function Show-PipPickList([bool]$OutdatedOnly=$false) {
    $pkgs = Get-PipPackages $OutdatedOnly
    if (-not $pkgs) { CC 'Green'; Write-Host "  No packages found."; RC; return $null }
    $i=1
    foreach ($p in $pkgs) {
        CC 'Yellow'; Write-Host -NoNewline "  [$i] "; RC
        if ($OutdatedOnly) {
            Write-Host "$($p.name)   $($p.version) → $($p.latest_version)"
        } else {
            Write-Host "$($p.name)   $($p.version)"
        }
        $i++
    }
    $sel = Read-MenuChoice $pkgs.Count
    if ($sel -le 0) { return $null }
    return $pkgs[$sel-1]
}

# ── PIP ──────────────────────────────────────────────────────────────────────
function Menu-Pip {
    do {
        Show-Banner; Show-PipArt; Write-ThinDivider
        $opts = @(
            "pip list                           list all installed packages"
            "pip list --outdated                show what is behind"
            "pip list --format=json             JSON output"
            "pip list -u                        up to date only"
            "pip show <package>                 info on a package"
            "pip check                          check for dependency conflicts"
            "pip freeze                         freeze current state"
            "pip freeze > requirements.txt      export to file"
            "pip install <package>              install (pick from outdated list)"
            "pip install <pkg>==version         install specific version"
            "pip install -U <package>           upgrade one (pick from outdated)"
            "pip install --upgrade <package>    upgrade one (alternate flag)"
            "pip install -r requirements.txt    install from file"
            "pip install -r requirements.txt --upgrade"
            "Upgrade ALL outdated packages"
            "pip-audit                          security scan"
            "pip-audit -r requirements.txt"
            "pip-audit --output json"
            "pip uninstall <package>            remove (pick from list)"
            "pip uninstall -r requirements.txt -y"
        )
        Show-MenuOptions $opts 'Yellow'
        $c = Read-MenuChoice $opts.Count
        switch ($c) {
            1  { if (Confirm-Action "pip list") { Invoke-Cmd "pip list" } }
            2  { if (Confirm-Action "pip list --outdated") { Invoke-Cmd "pip list --outdated" } }
            3  { if (Confirm-Action "pip list --format=json") { Invoke-Cmd "pip list --format=json" } }
            4  { if (Confirm-Action "pip list -u") { Invoke-Cmd "pip list -u" } }
            5  {
                $p = Show-PipPickList
                if ($p -and (Confirm-Action "pip show $($p.name)")) { Invoke-Cmd "pip show $($p.name)" }
            }
            6  { if (Confirm-Action "pip check") { Invoke-Cmd "pip check" } }
            7  { if (Confirm-Action "pip freeze") { Invoke-Cmd "pip freeze" } }
            8  { if (Confirm-Action "pip freeze > requirements.txt") { Invoke-Cmd "pip freeze > requirements.txt" } }
            9  {
                $p = Show-PipPickList $true
                if ($p -and (Confirm-Action "pip install $($p.name)")) { Invoke-Cmd "pip install $($p.name)" }
            }
            10 {
                $p = Show-PipPickList
                if ($p) {
                    CC 'Cyan'; Write-Host -NoNewline "  Version to pin (e.g. 2.28.0): "; RC
                    $ver = Read-Host
                    if ($ver -and (Confirm-Action "pip install $($p.name)==$ver")) { Invoke-Cmd "pip install $($p.name)==$ver" }
                }
            }
            11 {
                $p = Show-PipPickList $true
                if ($p -and (Confirm-Action "pip install -U $($p.name)")) { Invoke-Cmd "pip install -U $($p.name)" }
            }
            12 {
                $p = Show-PipPickList $true
                if ($p -and (Confirm-Action "pip install --upgrade $($p.name)")) { Invoke-Cmd "pip install --upgrade $($p.name)" }
            }
            13 { if (Confirm-Action "pip install -r requirements.txt") { Invoke-Cmd "pip install -r requirements.txt" } }
            14 { if (Confirm-Action "pip install -r requirements.txt --upgrade") { Invoke-Cmd "pip install -r requirements.txt --upgrade" } }
            15 {
                $pkgs = Get-PipPackages $true
                if (-not $pkgs) { CC 'Green'; Write-Host "  All up to date."; RC; break }
                $names = ($pkgs | ForEach-Object { $_.name }) -join ', '
                if (Confirm-Action "Upgrade ALL outdated: $names") {
                    foreach ($p in $pkgs) { Invoke-Cmd "pip install -U $($p.name)" }
                }
            }
            16 { if (Confirm-Action "pip-audit") { Invoke-Cmd "pip-audit" } }
            17 { if (Confirm-Action "pip-audit -r requirements.txt") { Invoke-Cmd "pip-audit -r requirements.txt" } }
            18 { if (Confirm-Action "pip-audit --output json") { Invoke-Cmd "pip-audit --output json" } }
            19 {
                $p = Show-PipPickList
                if ($p -and (Confirm-Action "pip uninstall $($p.name)")) { Invoke-Cmd "pip uninstall $($p.name) -y" }
            }
            20 { if (Confirm-Action "pip uninstall -r requirements.txt -y") { Invoke-Cmd "pip uninstall -r requirements.txt -y" } }
            0  { return }
        }
    } while ($true)
}

# ── NPM ──────────────────────────────────────────────────────────────────────
function Get-NpmOutdated {
    try { return npm outdated --json 2>$null | ConvertFrom-Json -AsHashtable } catch { return $null }
}
function Get-NpmPackageList {
    try {
        $raw = npm list --json 2>$null | ConvertFrom-Json
        if ($raw.dependencies) { return ($raw.dependencies | Get-Member -MemberType NoteProperty).Name }
    } catch {}
    return @()
}

function Menu-Npm {
    do {
        Show-Banner; Show-NpmArt; Write-ThinDivider
        $opts = @(
            "npm list                           list installed packages"
            "npm list --all                     full dependency tree"
            "npm outdated                       show outdated"
            "npm audit                          security scan"
            "npm audit --json                   security scan JSON"
            "npm audit --audit-level=high       flag high+ only"
            "npm audit --production             production deps only"
            "npm ls <package>                   dep tree for one package"
            "npm audit signatures               verify package signatures"
            "npm update                         update within semver ranges"
            "npm update <package>               update one (pick from outdated)"
            "npm install <package>@latest       force latest (pick from list)"
            "npm audit fix                      auto-fix safe vulns"
            "npm audit fix --dry-run            preview fix"
            "npm audit fix --force              ⚠ force — may break things"
            "npm audit fix --package-lock-only  update lockfile only"
            "ncu                                preview beyond-semver updates"
            "ncu -u                             write updates to package.json"
            "ncu -u --target patch              patch updates only"
            "ncu -u --target minor              minor updates only"
            "ncu -i                             interactive update mode"
        )
        Show-MenuOptions $opts 'Red'
        $c = Read-MenuChoice $opts.Count
        switch ($c) {
            1  { if (Confirm-Action "npm list") { Invoke-Cmd "npm list" } }
            2  { if (Confirm-Action "npm list --all") { Invoke-Cmd "npm list --all" } }
            3  { if (Confirm-Action "npm outdated") { Invoke-Cmd "npm outdated" } }
            4  { if (Confirm-Action "npm audit") { Invoke-Cmd "npm audit" } }
            5  { if (Confirm-Action "npm audit --json") { Invoke-Cmd "npm audit --json" } }
            6  { if (Confirm-Action "npm audit --audit-level=high") { Invoke-Cmd "npm audit --audit-level=high" } }
            7  { if (Confirm-Action "npm audit --production") { Invoke-Cmd "npm audit --production" } }
            8  {
                $pkgs = @(Get-NpmPackageList)
                if (-not $pkgs) { CC 'Red'; Write-Host "  No packages found."; RC; break }
                $i=1; foreach ($p in $pkgs) { CC 'Cyan'; Write-Host -NoNewline "  [$i] "; RC; Write-Host $p; $i++ }
                $sel = Read-MenuChoice $pkgs.Count
                if ($sel -gt 0 -and (Confirm-Action "npm ls $($pkgs[$sel-1])")) { Invoke-Cmd "npm ls $($pkgs[$sel-1])" }
            }
            9  { if (Confirm-Action "npm audit signatures") { Invoke-Cmd "npm audit signatures" } }
            10 { if (Confirm-Action "npm update (all within semver)") { Invoke-Cmd "npm update" } }
            11 {
                $raw = Get-NpmOutdated
                if (-not $raw -or $raw.Count -eq 0) { CC 'Green'; Write-Host "  All up to date."; RC; break }
                $pkgs = @($raw.Keys)
                $i=1; foreach ($p in $pkgs) { CC 'Yellow'; Write-Host -NoNewline "  [$i] "; RC; Write-Host "$p   $($raw[$p].current) → $($raw[$p].latest)"; $i++ }
                $sel = Read-MenuChoice $pkgs.Count
                if ($sel -gt 0 -and (Confirm-Action "npm update $($pkgs[$sel-1])")) { Invoke-Cmd "npm update $($pkgs[$sel-1])" }
            }
            12 {
                $pkgs = @(Get-NpmPackageList)
                if (-not $pkgs) { CC 'Red'; Write-Host "  No packages found."; RC; break }
                $i=1; foreach ($p in $pkgs) { CC 'Cyan'; Write-Host -NoNewline "  [$i] "; RC; Write-Host $p; $i++ }
                $sel = Read-MenuChoice $pkgs.Count
                if ($sel -gt 0 -and (Confirm-Action "npm install $($pkgs[$sel-1])@latest")) { Invoke-Cmd "npm install $($pkgs[$sel-1])@latest" }
            }
            13 { if (Confirm-Action "npm audit fix") { Invoke-Cmd "npm audit fix" } }
            14 { if (Confirm-Action "npm audit fix --dry-run") { Invoke-Cmd "npm audit fix --dry-run" } }
            15 { if (Confirm-Action "⚠ npm audit fix --force — may break things") { Invoke-Cmd "npm audit fix --force" } }
            16 { if (Confirm-Action "npm audit fix --package-lock-only") { Invoke-Cmd "npm audit fix --package-lock-only" } }
            17 { if (Confirm-Action "ncu (preview)") { Invoke-Cmd "ncu" } }
            18 { if (Confirm-Action "ncu -u (writes package.json)") { Invoke-Cmd "ncu -u" } }
            19 { if (Confirm-Action "ncu -u --target patch") { Invoke-Cmd "ncu -u --target patch" } }
            20 { if (Confirm-Action "ncu -u --target minor") { Invoke-Cmd "ncu -u --target minor" } }
            21 { if (Confirm-Action "ncu -i (interactive)") { Invoke-Cmd "ncu -i" } }
            0  { return }
        }
    } while ($true)
}

# ── YARN ─────────────────────────────────────────────────────────────────────
function Menu-Yarn {
    do {
        Show-Banner; Show-YarnArt; Write-ThinDivider
        $opts = @(
            "yarn install                       install all dependencies"
            "yarn add <package>                 add a dependency"
            "yarn add -D <package>              add devDependency"
            "yarn remove <package>              remove (pick from list)"
            "yarn upgrade                       update all"
            "yarn upgrade <package>             update one (pick from outdated)"
            "yarn upgrade-interactive           interactive update"
            "yarn upgrade-interactive --latest  ignore semver, go latest"
            "yarn outdated                      show outdated"
            "yarn audit                         security scan"
            "yarn audit --level high            flag high+ only"
            "yarn set version berry             upgrade to v4"
        )
        Show-MenuOptions $opts 'Blue'
        $c = Read-MenuChoice $opts.Count
        switch ($c) {
            1  { if (Confirm-Action "yarn install") { Invoke-Cmd "yarn install" } }
            2  { if (Confirm-Action "yarn add (install deps first, then pick)") { Invoke-Cmd "yarn add" } }
            3  { if (Confirm-Action "yarn add -D") { Invoke-Cmd "yarn add -D" } }
            4  {
                try {
                    $raw = yarn list --json 2>$null
                    $pkgs = @()
                    foreach ($line in $raw) {
                        try { $obj = $line | ConvertFrom-Json; if ($obj.type -eq 'tree') { $pkgs = $obj.data.trees | ForEach-Object { $_.name -replace '@[^@]+$','' } } } catch {}
                    }
                    if (-not $pkgs) { CC 'Red'; Write-Host "  Could not list packages."; RC; break }
                    $i=1; foreach ($p in $pkgs) { CC 'Cyan'; Write-Host -NoNewline "  [$i] "; RC; Write-Host $p; $i++ }
                    $sel = Read-MenuChoice $pkgs.Count
                    if ($sel -gt 0 -and (Confirm-Action "yarn remove $($pkgs[$sel-1])")) { Invoke-Cmd "yarn remove $($pkgs[$sel-1])" }
                } catch { CC 'Red'; Write-Host "  Could not list packages."; RC }
            }
            5  { if (Confirm-Action "yarn upgrade (all)") { Invoke-Cmd "yarn upgrade" } }
            6  {
                try {
                    $pkgs = @()
                    yarn outdated --json 2>$null | ForEach-Object {
                        try { $obj = $_ | ConvertFrom-Json; if ($obj.type -eq 'table') { $pkgs = $obj.data.body } } catch {}
                    }
                    if (-not $pkgs) { CC 'Green'; Write-Host "  All up to date."; RC; break }
                    $i=1; foreach ($p in $pkgs) { CC 'Yellow'; Write-Host -NoNewline "  [$i] "; RC; Write-Host "$($p[0])   $($p[1]) → $($p[3])"; $i++ }
                    $sel = Read-MenuChoice $pkgs.Count
                    if ($sel -gt 0 -and (Confirm-Action "yarn upgrade $($pkgs[$sel-1][0])")) { Invoke-Cmd "yarn upgrade $($pkgs[$sel-1][0])" }
                } catch { CC 'Red'; Write-Host "  Error listing outdated."; RC }
            }
            7  { if (Confirm-Action "yarn upgrade-interactive") { Invoke-Cmd "yarn upgrade-interactive" } }
            8  { if (Confirm-Action "yarn upgrade-interactive --latest") { Invoke-Cmd "yarn upgrade-interactive --latest" } }
            9  { if (Confirm-Action "yarn outdated") { Invoke-Cmd "yarn outdated" } }
            10 { if (Confirm-Action "yarn audit") { Invoke-Cmd "yarn audit" } }
            11 { if (Confirm-Action "yarn audit --level high") { Invoke-Cmd "yarn audit --level high" } }
            12 { if (Confirm-Action "yarn set version berry") { Invoke-Cmd "yarn set version berry" } }
            0  { return }
        }
    } while ($true)
}

# ── PNPM ─────────────────────────────────────────────────────────────────────
function Menu-Pnpm {
    do {
        Show-Banner; Show-PnpmArt; Write-ThinDivider
        $opts = @(
            "pnpm install                       install all dependencies"
            "pnpm add <package>                 add dependency"
            "pnpm add -D <package>              add devDependency"
            "pnpm remove <package>              remove (pick from list)"
            "pnpm update                        update all within semver"
            "pnpm update <package>              update one (pick from outdated)"
            "pnpm update --latest               ignore semver — go latest"
            "pnpm outdated                      show outdated"
            "pnpm audit                         security scan"
            "pnpm audit --audit-level high      flag high+ only"
            "pnpm list                          list installed"
            "pnpm why <package>                 why is this installed"
        )
        Show-MenuOptions $opts 'Yellow'
        $c = Read-MenuChoice $opts.Count
        switch ($c) {
            1  { if (Confirm-Action "pnpm install") { Invoke-Cmd "pnpm install" } }
            2  { if (Confirm-Action "pnpm add") { Invoke-Cmd "pnpm add" } }
            3  { if (Confirm-Action "pnpm add -D") { Invoke-Cmd "pnpm add -D" } }
            4  {
                try {
                    $raw = pnpm list --json 2>$null | ConvertFrom-Json
                    $names = @($raw[0].dependencies.PSObject.Properties.Name)
                    if (-not $names) { CC 'Red'; Write-Host "  No packages found."; RC; break }
                    $i=1; foreach ($p in $names) { CC 'Cyan'; Write-Host -NoNewline "  [$i] "; RC; Write-Host $p; $i++ }
                    $sel = Read-MenuChoice $names.Count
                    if ($sel -gt 0 -and (Confirm-Action "pnpm remove $($names[$sel-1])")) { Invoke-Cmd "pnpm remove $($names[$sel-1])" }
                } catch { CC 'Red'; Write-Host "  Error listing packages."; RC }
            }
            5  { if (Confirm-Action "pnpm update (all within semver)") { Invoke-Cmd "pnpm update" } }
            6  {
                try {
                    $raw = pnpm outdated --format json 2>$null | ConvertFrom-Json -AsHashtable
                    if (-not $raw -or $raw.Count -eq 0) { CC 'Green'; Write-Host "  All up to date."; RC; break }
                    $pkgs = @($raw.Keys)
                    $i=1; foreach ($p in $pkgs) { CC 'Yellow'; Write-Host -NoNewline "  [$i] "; RC; Write-Host "$p   $($raw[$p].current) → $($raw[$p].latest)"; $i++ }
                    $sel = Read-MenuChoice $pkgs.Count
                    if ($sel -gt 0 -and (Confirm-Action "pnpm update $($pkgs[$sel-1])")) { Invoke-Cmd "pnpm update $($pkgs[$sel-1])" }
                } catch { CC 'Red'; Write-Host "  Error listing outdated."; RC }
            }
            7  { if (Confirm-Action "pnpm update --latest (ignores semver)") { Invoke-Cmd "pnpm update --latest" } }
            8  { if (Confirm-Action "pnpm outdated") { Invoke-Cmd "pnpm outdated" } }
            9  { if (Confirm-Action "pnpm audit") { Invoke-Cmd "pnpm audit" } }
            10 { if (Confirm-Action "pnpm audit --audit-level high") { Invoke-Cmd "pnpm audit --audit-level high" } }
            11 { if (Confirm-Action "pnpm list") { Invoke-Cmd "pnpm list" } }
            12 {
                try {
                    $raw = pnpm list --json 2>$null | ConvertFrom-Json
                    $names = @($raw[0].dependencies.PSObject.Properties.Name)
                    if (-not $names) { CC 'Red'; Write-Host "  No packages found."; RC; break }
                    $i=1; foreach ($p in $names) { CC 'Cyan'; Write-Host -NoNewline "  [$i] "; RC; Write-Host $p; $i++ }
                    $sel = Read-MenuChoice $names.Count
                    if ($sel -gt 0 -and (Confirm-Action "pnpm why $($names[$sel-1])")) { Invoke-Cmd "pnpm why $($names[$sel-1])" }
                } catch { CC 'Red'; Write-Host "  Error."; RC }
            }
            0  { return }
        }
    } while ($true)
}

# helper to parse winget list output into id array
function Get-WingetIds([bool]$UpgradeOnly=$false) {
    $ids = @(); $inT = $false
    $cmd = if ($UpgradeOnly) { "winget list --upgrade-available" } else { "winget list" }
    Invoke-Expression "$cmd 2>`$null" | ForEach-Object {
        if ($_ -match '^-{3,}') { $inT = $true; return }
        if (-not $inT -or $_.Trim() -eq '') { return }
        $cols = $_ -split '\s{2,}'
        if ($cols.Count -ge 2) { $ids += [pscustomobject]@{ Name=$cols[0].Trim(); Id=$cols[1].Trim(); Current=($cols[2]??'-').Trim(); Latest=($cols[3]??'-').Trim() } }
    }
    return $ids
}

# ── WINGET ───────────────────────────────────────────────────────────────────
function Menu-Winget {
    do {
        Show-Banner; Show-WingetArt; Write-ThinDivider
        $opts = @(
            "winget list                        list all installed apps"
            "winget list --upgrade-available    show what has updates"
            "winget search <term>               search packages"
            "winget show <id>                   details on one package"
            "winget --version"
            "winget --info"
            "winget upgrade                     preview available upgrades"
            "winget upgrade <id>                upgrade one (pick from available)"
            "winget upgrade --all"
            "winget upgrade --all --silent"
            "winget upgrade --all --include-unknown"
            "winget upgrade --all --include-pinned"
            "winget upgrade --all (CI silent mode)"
            "winget install <id>                install (search then pick)"
            "winget uninstall <id>              uninstall (pick from list)"
            "winget export -o apps.json"
            "winget import -i apps.json"
            "winget source list"
            "winget upgrade --all --source winget"
            "winget upgrade --all --source msstore"
        )
        Show-MenuOptions $opts 'Cyan'
        $c = Read-MenuChoice $opts.Count
        switch ($c) {
            1  { if (Confirm-Action "winget list") { Invoke-Cmd "winget list" } }
            2  { if (Confirm-Action "winget list --upgrade-available") { Invoke-Cmd "winget list --upgrade-available" } }
            3  {
                CC 'Cyan'; Write-Host -NoNewline "  Search term: "; RC
                $term = Read-Host
                if ($term -and (Confirm-Action "winget search $term")) { Invoke-Cmd "winget search $term" }
            }
            4  {
                $ids = @(Get-WingetIds)
                if (-not $ids) { CC 'Red'; Write-Host "  No apps found."; RC; break }
                $i=1; foreach ($a in $ids) { CC 'Cyan'; Write-Host -NoNewline "  [$i] "; RC; Write-Host "$($a.Id)   $($a.Name)"; $i++ }
                $sel = Read-MenuChoice $ids.Count
                if ($sel -gt 0 -and (Confirm-Action "winget show $($ids[$sel-1].Id)")) { Invoke-Cmd "winget show $($ids[$sel-1].Id)" }
            }
            5  { if (Confirm-Action "winget --version") { Invoke-Cmd "winget --version" } }
            6  { if (Confirm-Action "winget --info") { Invoke-Cmd "winget --info" } }
            7  { if (Confirm-Action "winget upgrade (preview)") { Invoke-Cmd "winget upgrade" } }
            8  {
                $ids = @(Get-WingetIds $true)
                if (-not $ids) { CC 'Green'; Write-Host "  Nothing to upgrade."; RC; break }
                $i=1; foreach ($a in $ids) { CC 'Yellow'; Write-Host -NoNewline "  [$i] "; RC; Write-Host "$($a.Id)   $($a.Current) → $($a.Latest)"; $i++ }
                $sel = Read-MenuChoice $ids.Count
                if ($sel -gt 0 -and (Confirm-Action "winget upgrade $($ids[$sel-1].Id)")) {
                    Invoke-Cmd "winget upgrade --id $($ids[$sel-1].Id) --silent --accept-package-agreements --accept-source-agreements"
                }
            }
            9  { if (Confirm-Action "winget upgrade --all") { Invoke-Cmd "winget upgrade --all" } }
            10 { if (Confirm-Action "winget upgrade --all --silent") { Invoke-Cmd "winget upgrade --all --silent" } }
            11 { if (Confirm-Action "winget upgrade --all --include-unknown") { Invoke-Cmd "winget upgrade --all --include-unknown" } }
            12 { if (Confirm-Action "winget upgrade --all --include-pinned") { Invoke-Cmd "winget upgrade --all --include-pinned" } }
            13 { if (Confirm-Action "CI silent upgrade (all flags)") { Invoke-Cmd "winget upgrade --all --silent --disable-interactivity --accept-package-agreements --accept-source-agreements" } }
            14 {
                CC 'Cyan'; Write-Host -NoNewline "  Search term: "; RC
                $term = Read-Host; if (-not $term) { break }
                Invoke-Expression "winget search $term"
                CC 'Cyan'; Write-Host -NoNewline "  Exact ID to install: "; RC
                $id = Read-Host
                if ($id -and (Confirm-Action "winget install $id")) { Invoke-Cmd "winget install --id $id --silent --accept-package-agreements --accept-source-agreements" }
            }
            15 {
                $ids = @(Get-WingetIds)
                if (-not $ids) { CC 'Red'; Write-Host "  No apps found."; RC; break }
                $i=1; foreach ($a in $ids) { CC 'Cyan'; Write-Host -NoNewline "  [$i] "; RC; Write-Host "$($a.Id)   $($a.Name)"; $i++ }
                $sel = Read-MenuChoice $ids.Count
                if ($sel -gt 0 -and (Confirm-Action "winget uninstall $($ids[$sel-1].Id)")) { Invoke-Cmd "winget uninstall --id $($ids[$sel-1].Id) --silent" }
            }
            16 { if (Confirm-Action "winget export -o apps.json") { Invoke-Cmd "winget export -o apps.json" } }
            17 { if (Confirm-Action "winget import -i apps.json") { Invoke-Cmd "winget import -i apps.json" } }
            18 { if (Confirm-Action "winget source list") { Invoke-Cmd "winget source list" } }
            19 { if (Confirm-Action "winget upgrade --all --source winget") { Invoke-Cmd "winget upgrade --all --source winget" } }
            20 { if (Confirm-Action "winget upgrade --all --source msstore") { Invoke-Cmd "winget upgrade --all --source msstore" } }
            0  { return }
        }
    } while ($true)
}

# ── CHOCO ────────────────────────────────────────────────────────────────────
function Get-ChocoPkgs([bool]$OutdatedOnly=$false) {
    try {
        if ($OutdatedOnly) {
            return @(choco outdated --limit-output 2>$null | ForEach-Object {
                $p = $_ -split '\|'; if ($p.Count -ge 3) { [pscustomobject]@{Name=$p[0];Current=$p[1];Latest=$p[2]} }
            } | Where-Object { $_ })
        } else {
            return @(choco list --local-only --limit-output 2>$null | ForEach-Object {
                $p = $_ -split '\|'; if ($p.Count -ge 1) { [pscustomobject]@{Name=$p[0];Version=($p[1]??'-')} }
            } | Where-Object { $_ })
        }
    } catch { return @() }
}

function Menu-Choco {
    do {
        Show-Banner; Show-ChocoArt; Write-ThinDivider
        $opts = @(
            "choco list --local-only            list installed packages"
            "choco outdated                     show outdated"
            "choco search <term>                search"
            "choco install <package>            install (search then pick)"
            "choco install <pkg1> <pkg2>        install multiple"
            "choco upgrade <package>            upgrade one (pick from outdated)"
            "choco upgrade all                  upgrade everything"
            "choco uninstall <package>          uninstall (pick from installed)"
        )
        Show-MenuOptions $opts 'DarkYellow'
        $c = Read-MenuChoice $opts.Count
        switch ($c) {
            1 { if (Confirm-Action "choco list --local-only") { Invoke-Cmd "choco list --local-only" } }
            2 { if (Confirm-Action "choco outdated") { Invoke-Cmd "choco outdated" } }
            3 {
                CC 'Cyan'; Write-Host -NoNewline "  Search term: "; RC
                $term = Read-Host
                if ($term -and (Confirm-Action "choco search $term")) { Invoke-Cmd "choco search $term" }
            }
            4 {
                CC 'Cyan'; Write-Host -NoNewline "  Search term: "; RC
                $term = Read-Host; if (-not $term) { break }
                Invoke-Expression "choco search $term"
                CC 'Cyan'; Write-Host -NoNewline "  Package ID to install: "; RC
                $pkg = Read-Host
                if ($pkg -and (Confirm-Action "choco install $pkg")) { Invoke-Cmd "choco install $pkg -y" }
            }
            5 {
                CC 'Cyan'; Write-Host -NoNewline "  Package names (space-separated): "; RC
                $pkgs = Read-Host
                if ($pkgs -and (Confirm-Action "choco install $pkgs")) { Invoke-Cmd "choco install $pkgs -y" }
            }
            6 {
                $pkgs = @(Get-ChocoPkgs $true)
                if (-not $pkgs) { CC 'Green'; Write-Host "  All up to date."; RC; break }
                $i=1; foreach ($p in $pkgs) { CC 'Yellow'; Write-Host -NoNewline "  [$i] "; RC; Write-Host "$($p.Name)   $($p.Current) → $($p.Latest)"; $i++ }
                $sel = Read-MenuChoice $pkgs.Count
                if ($sel -gt 0 -and (Confirm-Action "choco upgrade $($pkgs[$sel-1].Name)")) { Invoke-Cmd "choco upgrade $($pkgs[$sel-1].Name) -y" }
            }
            7 { if (Confirm-Action "choco upgrade all") { Invoke-Cmd "choco upgrade all -y" } }
            8 {
                $pkgs = @(Get-ChocoPkgs)
                if (-not $pkgs) { CC 'Red'; Write-Host "  No packages found."; RC; break }
                $i=1; foreach ($p in $pkgs) { CC 'Cyan'; Write-Host -NoNewline "  [$i] "; RC; Write-Host "$($p.Name)   $($p.Version)"; $i++ }
                $sel = Read-MenuChoice $pkgs.Count
                if ($sel -gt 0 -and (Confirm-Action "choco uninstall $($pkgs[$sel-1].Name)")) { Invoke-Cmd "choco uninstall $($pkgs[$sel-1].Name) -y" }
            }
            0 { return }
        }
    } while ($true)
}

# ── BREW ─────────────────────────────────────────────────────────────────────
function Menu-Brew {
    do {
        Show-Banner; Show-BrewArt; Write-ThinDivider
        $opts = @(
            "brew update                        update brew itself"
            "brew upgrade                       upgrade all packages"
            "brew upgrade <package>             upgrade one (pick from outdated)"
            "brew outdated                      show outdated"
            "brew list                          list installed"
            "brew info <package>                info (pick from list)"
            "brew search <term>                 search"
            "brew install <package>             install"
            "brew install --cask <app>          install GUI app"
            "brew uninstall <package>           uninstall (pick from list)"
            "brew doctor                        diagnose issues"
            "brew audit                         audit formulas"
        )
        Show-MenuOptions $opts 'Green'
        $c = Read-MenuChoice $opts.Count
        switch ($c) {
            1  { if (Confirm-Action "brew update") { Invoke-Cmd "brew update" } }
            2  { if (Confirm-Action "brew upgrade (all)") { Invoke-Cmd "brew upgrade" } }
            3  {
                $pkgs = @(brew outdated 2>$null | ForEach-Object { ($_ -split '\s+')[0] })
                if (-not $pkgs) { CC 'Green'; Write-Host "  Nothing outdated."; RC; break }
                $i=1; foreach ($p in $pkgs) { CC 'Yellow'; Write-Host -NoNewline "  [$i] "; RC; Write-Host $p; $i++ }
                $sel = Read-MenuChoice $pkgs.Count
                if ($sel -gt 0 -and (Confirm-Action "brew upgrade $($pkgs[$sel-1])")) { Invoke-Cmd "brew upgrade $($pkgs[$sel-1])" }
            }
            4  { if (Confirm-Action "brew outdated") { Invoke-Cmd "brew outdated" } }
            5  { if (Confirm-Action "brew list") { Invoke-Cmd "brew list" } }
            6  {
                $pkgs = @(brew list 2>$null)
                $i=1; foreach ($p in $pkgs) { CC 'Cyan'; Write-Host -NoNewline "  [$i] "; RC; Write-Host $p; $i++ }
                $sel = Read-MenuChoice $pkgs.Count
                if ($sel -gt 0 -and (Confirm-Action "brew info $($pkgs[$sel-1])")) { Invoke-Cmd "brew info $($pkgs[$sel-1])" }
            }
            7  {
                CC 'Cyan'; Write-Host -NoNewline "  Search term: "; RC
                $term = Read-Host
                if ($term -and (Confirm-Action "brew search $term")) { Invoke-Cmd "brew search $term" }
            }
            8  {
                CC 'Cyan'; Write-Host -NoNewline "  Package to install: "; RC
                $pkg = Read-Host
                if ($pkg -and (Confirm-Action "brew install $pkg")) { Invoke-Cmd "brew install $pkg" }
            }
            9  {
                CC 'Cyan'; Write-Host -NoNewline "  Cask app to install: "; RC
                $pkg = Read-Host
                if ($pkg -and (Confirm-Action "brew install --cask $pkg")) { Invoke-Cmd "brew install --cask $pkg" }
            }
            10 {
                $pkgs = @(brew list 2>$null)
                $i=1; foreach ($p in $pkgs) { CC 'Cyan'; Write-Host -NoNewline "  [$i] "; RC; Write-Host $p; $i++ }
                $sel = Read-MenuChoice $pkgs.Count
                if ($sel -gt 0 -and (Confirm-Action "brew uninstall $($pkgs[$sel-1])")) { Invoke-Cmd "brew uninstall $($pkgs[$sel-1])" }
            }
            11 { if (Confirm-Action "brew doctor") { Invoke-Cmd "brew doctor" } }
            12 { if (Confirm-Action "brew audit") { Invoke-Cmd "brew audit" } }
            0  { return }
        }
    } while ($true)
}

# ── APT ──────────────────────────────────────────────────────────────────────
function Menu-Apt {
    do {
        Show-Banner; Show-AptArt; Write-ThinDivider
        $opts = @(
            "sudo apt update                    refresh package index"
            "sudo apt upgrade                   upgrade all packages"
            "sudo apt full-upgrade              upgrade + remove obsolete"
            "sudo apt install <package>         install (search then pick)"
            "sudo apt remove <package>          remove (pick from installed)"
            "sudo apt autoremove                clean unused dependencies"
            "apt list --installed               all installed packages"
            "apt list --upgradable              show what has updates"
            "apt-cache search <term>            search packages"
            "apt-cache show <package>           package info (pick from installed)"
            "sudo apt-get dist-upgrade          full system upgrade"
        )
        Show-MenuOptions $opts 'Magenta'
        $c = Read-MenuChoice $opts.Count
        switch ($c) {
            1  { if (Confirm-Action "sudo apt update") { Invoke-Cmd "sudo apt update" } }
            2  { if (Confirm-Action "sudo apt upgrade") { Invoke-Cmd "sudo apt upgrade -y" } }
            3  { if (Confirm-Action "sudo apt full-upgrade") { Invoke-Cmd "sudo apt full-upgrade -y" } }
            4  {
                CC 'Cyan'; Write-Host -NoNewline "  Search term: "; RC
                $term = Read-Host; if (-not $term) { break }
                Invoke-Expression "apt-cache search $term"
                CC 'Cyan'; Write-Host -NoNewline "  Package to install: "; RC
                $pkg = Read-Host
                if ($pkg -and (Confirm-Action "sudo apt install $pkg")) { Invoke-Cmd "sudo apt install $pkg -y" }
            }
            5  {
                $pkgs = @(apt list --installed 2>$null | Where-Object { $_ -match '\[installed\]' } | ForEach-Object { ($_ -split '/')[0] } | Select-Object -First 100)
                if (-not $pkgs) { CC 'Red'; Write-Host "  Could not list packages."; RC; break }
                $i=1; foreach ($p in $pkgs) { CC 'Cyan'; Write-Host -NoNewline "  [$i] "; RC; Write-Host $p; $i++ }
                $sel = Read-MenuChoice $pkgs.Count
                if ($sel -gt 0 -and (Confirm-Action "sudo apt remove $($pkgs[$sel-1])")) { Invoke-Cmd "sudo apt remove $($pkgs[$sel-1]) -y" }
            }
            6  { if (Confirm-Action "sudo apt autoremove") { Invoke-Cmd "sudo apt autoremove -y" } }
            7  { if (Confirm-Action "apt list --installed") { Invoke-Cmd "apt list --installed" } }
            8  { if (Confirm-Action "apt list --upgradable") { Invoke-Cmd "apt list --upgradable" } }
            9  {
                CC 'Cyan'; Write-Host -NoNewline "  Search term: "; RC
                $term = Read-Host
                if ($term -and (Confirm-Action "apt-cache search $term")) { Invoke-Cmd "apt-cache search $term" }
            }
            10 {
                $pkgs = @(apt list --installed 2>$null | Where-Object { $_ -match '\[installed\]' } | ForEach-Object { ($_ -split '/')[0] } | Select-Object -First 100)
                $i=1; foreach ($p in $pkgs) { CC 'Cyan'; Write-Host -NoNewline "  [$i] "; RC; Write-Host $p; $i++ }
                $sel = Read-MenuChoice $pkgs.Count
                if ($sel -gt 0 -and (Confirm-Action "apt-cache show $($pkgs[$sel-1])")) { Invoke-Cmd "apt-cache show $($pkgs[$sel-1])" }
            }
            11 { if (Confirm-Action "sudo apt-get dist-upgrade") { Invoke-Cmd "sudo apt-get dist-upgrade -y" } }
            0  { return }
        }
    } while ($true)
}

# ── CARGO ────────────────────────────────────────────────────────────────────
function Menu-Cargo {
    do {
        Show-Banner; Show-CargoArt; Write-ThinDivider
        $opts = @(
            "cargo build                        build project"
            "cargo update                       update Cargo.lock"
            "cargo outdated                     show outdated (needs cargo-outdated)"
            "cargo audit                        security scan (needs cargo-audit)"
            "cargo install cargo-outdated       install outdated checker"
            "cargo install cargo-audit          install security scanner"
            "cargo add <crate>                  add dependency (pick from outdated)"
            "cargo remove <crate>               remove (pick from metadata)"
            "cargo tree                         show dependency tree"
        )
        Show-MenuOptions $opts 'Red'
        $c = Read-MenuChoice $opts.Count
        switch ($c) {
            1 { if (Confirm-Action "cargo build") { Invoke-Cmd "cargo build" } }
            2 { if (Confirm-Action "cargo update") { Invoke-Cmd "cargo update" } }
            3 { if (Confirm-Action "cargo outdated") { Invoke-Cmd "cargo outdated" } }
            4 { if (Confirm-Action "cargo audit") { Invoke-Cmd "cargo audit" } }
            5 { if (Confirm-Action "cargo install cargo-outdated") { Invoke-Cmd "cargo install cargo-outdated" } }
            6 { if (Confirm-Action "cargo install cargo-audit") { Invoke-Cmd "cargo install cargo-audit" } }
            7 {
                try {
                    $raw = cargo outdated --format json 2>$null | ConvertFrom-Json
                    $pkgs = @($raw.dependencies | Where-Object { $_.latest -ne $_.project })
                    if (-not $pkgs) { CC 'Green'; Write-Host "  All up to date (or cargo-outdated not installed)."; RC; break }
                    $i=1; foreach ($p in $pkgs) { CC 'Yellow'; Write-Host -NoNewline "  [$i] "; RC; Write-Host "$($p.name)   $($p.project) → $($p.latest)"; $i++ }
                    $sel = Read-MenuChoice $pkgs.Count
                    if ($sel -gt 0 -and (Confirm-Action "cargo add $($pkgs[$sel-1].name)")) { Invoke-Cmd "cargo add $($pkgs[$sel-1].name)" }
                } catch { CC 'Red'; Write-Host "  cargo-outdated not installed or not in a Cargo project."; RC }
            }
            8 {
                try {
                    $raw = cargo metadata --format-version 1 --no-deps 2>$null | ConvertFrom-Json
                    $pkgs = @($raw.packages.name)
                    if (-not $pkgs) { CC 'Red'; Write-Host "  No packages (run inside a Cargo project)."; RC; break }
                    $i=1; foreach ($p in $pkgs) { CC 'Cyan'; Write-Host -NoNewline "  [$i] "; RC; Write-Host $p; $i++ }
                    $sel = Read-MenuChoice $pkgs.Count
                    if ($sel -gt 0 -and (Confirm-Action "cargo remove $($pkgs[$sel-1])")) { Invoke-Cmd "cargo remove $($pkgs[$sel-1])" }
                } catch { CC 'Red'; Write-Host "  Not in a Cargo project."; RC }
            }
            9 { if (Confirm-Action "cargo tree") { Invoke-Cmd "cargo tree" } }
            0 { return }
        }
    } while ($true)
}

# ── GEM ──────────────────────────────────────────────────────────────────────
function Menu-Gem {
    do {
        Show-Banner; Show-GemArt; Write-ThinDivider
        $opts = @(
            "gem install <gem>                  install"
            "gem update                         update all gems"
            "gem update <gem>                   update one (pick from outdated)"
            "gem list                           list installed gems"
            "gem outdated                       show outdated gems"
            "gem cleanup                        remove old versions"
            "bundle install                     install from Gemfile"
            "bundle update                      update all in Gemfile"
            "bundle outdated                    show outdated in Gemfile"
            "bundle audit                       security scan (needs bundler-audit)"
        )
        Show-MenuOptions $opts 'Magenta'
        $c = Read-MenuChoice $opts.Count
        switch ($c) {
            1  {
                CC 'Cyan'; Write-Host -NoNewline "  Gem name: "; RC
                $pkg = Read-Host
                if ($pkg -and (Confirm-Action "gem install $pkg")) { Invoke-Cmd "gem install $pkg" }
            }
            2  { if (Confirm-Action "gem update (all)") { Invoke-Cmd "gem update" } }
            3  {
                $pkgs = @(gem outdated 2>$null | ForEach-Object {
                    if ($_ -match '^(\S+)\s+\((\S+)\s+<\s+(\S+)\)') {
                        [pscustomobject]@{Name=$Matches[1];Current=$Matches[2];Latest=$Matches[3]}
                    }
                } | Where-Object { $_ })
                if (-not $pkgs) { CC 'Green'; Write-Host "  All gems up to date."; RC; break }
                $i=1; foreach ($p in $pkgs) { CC 'Yellow'; Write-Host -NoNewline "  [$i] "; RC; Write-Host "$($p.Name)   $($p.Current) → $($p.Latest)"; $i++ }
                $sel = Read-MenuChoice $pkgs.Count
                if ($sel -gt 0 -and (Confirm-Action "gem update $($pkgs[$sel-1].Name)")) { Invoke-Cmd "gem update $($pkgs[$sel-1].Name)" }
            }
            4  { if (Confirm-Action "gem list") { Invoke-Cmd "gem list" } }
            5  { if (Confirm-Action "gem outdated") { Invoke-Cmd "gem outdated" } }
            6  { if (Confirm-Action "gem cleanup") { Invoke-Cmd "gem cleanup" } }
            7  { if (Confirm-Action "bundle install") { Invoke-Cmd "bundle install" } }
            8  { if (Confirm-Action "bundle update") { Invoke-Cmd "bundle update" } }
            9  { if (Confirm-Action "bundle outdated") { Invoke-Cmd "bundle outdated" } }
            10 { if (Confirm-Action "bundle audit") { Invoke-Cmd "bundle audit" } }
            0  { return }
        }
    } while ($true)
}

# ── GO ───────────────────────────────────────────────────────────────────────
function Menu-Go {
    do {
        Show-Banner; Show-GoArt; Write-ThinDivider
        $opts = @(
            "go mod init                        initialize new module"
            "go get <package>                   add or update (pick from outdated)"
            "go get -u all                      update all dependencies"
            "go mod tidy                        clean unused dependencies"
            "go mod download                    download all dependencies"
            "go list -m -u all                  list all modules with update info"
            "go install govulncheck             install vulnerability checker"
            "govulncheck ./...                  run security scan"
        )
        Show-MenuOptions $opts 'Cyan'
        $c = Read-MenuChoice $opts.Count
        switch ($c) {
            1 { if (Confirm-Action "go mod init") { Invoke-Cmd "go mod init" } }
            2 {
                try {
                    $buf = ''; $mods = @()
                    go list -m -u -json all 2>$null | ForEach-Object {
                        $buf += $_
                        try { $obj = $buf | ConvertFrom-Json -ErrorAction Stop; $mods += $obj; $buf = '' } catch {}
                    }
                    $outdated = @($mods | Where-Object { $_.Update })
                    if (-not $outdated) { CC 'Green'; Write-Host "  All modules up to date."; RC; break }
                    $i=1; foreach ($m in $outdated) { CC 'Yellow'; Write-Host -NoNewline "  [$i] "; RC; Write-Host "$($m.Path)   $($m.Version) → $($m.Update.Version)"; $i++ }
                    $sel = Read-MenuChoice $outdated.Count
                    if ($sel -gt 0 -and (Confirm-Action "go get $($outdated[$sel-1].Path)@latest")) { Invoke-Cmd "go get $($outdated[$sel-1].Path)@latest" }
                } catch { CC 'Red'; Write-Host "  Not in a Go module directory."; RC }
            }
            3 { if (Confirm-Action "go get -u all") { Invoke-Cmd "go get -u all" } }
            4 { if (Confirm-Action "go mod tidy") { Invoke-Cmd "go mod tidy" } }
            5 { if (Confirm-Action "go mod download") { Invoke-Cmd "go mod download" } }
            6 { if (Confirm-Action "go list -m -u all") { Invoke-Cmd "go list -m -u all" } }
            7 { if (Confirm-Action "go install govulncheck@latest") { Invoke-Cmd "go install golang.org/x/vuln/cmd/govulncheck@latest" } }
            8 { if (Confirm-Action "govulncheck ./...") { Invoke-Cmd "govulncheck ./..." } }
            0 { return }
        }
    } while ($true)
}

# ══════════════════════════════════════════════════════════════════════════════
#  MAIN MENU
# ══════════════════════════════════════════════════════════════════════════════
function Show-MainMenu {
    do {
        Show-Banner
        Show-Dashboard

        CC 'DarkCyan'
        Write-Host "  ╔═══════════════════════════════════════════════════════════════════════╗"
        CC 'Yellow'
        Write-Host "  ║  SCAN                                                                 ║"
        CC 'White'
        Write-Host "  ║    [1]  Scan packages (pick which managers)                           ║"
        Write-Host "  ║    [2]  Re-scan all previously scanned managers                       ║"
        CC 'DarkCyan'
        Write-Host "  ╠═══════════════════════════════════════════════════════════════════════╣"
        CC 'Yellow'
        Write-Host "  ║  VIEW FLAGS & ACT                                                     ║"
        CC 'White'
        Write-Host "  ║    [3] pip      [4] npm      [5] yarn     [6] pnpm     [7] winget     ║"
        Write-Host "  ║    [8] choco    [9] brew    [10] apt     [11] cargo   [12] gem/go     ║"
        CC 'DarkCyan'
        Write-Host "  ╠═══════════════════════════════════════════════════════════════════════╣"
        CC 'Yellow'
        Write-Host "  ║  MANUAL COMMAND MENUS                                                 ║"
        CC 'White'
        Write-Host "  ║   [13] pip     [14] npm     [15] yarn    [16] pnpm    [17] winget     ║"
        Write-Host "  ║   [18] choco   [19] brew    [20] apt     [21] cargo   [22] gem        ║"
        Write-Host "  ║   [23] go modules                                                     ║"
        CC 'DarkCyan'
        Write-Host "  ╠═══════════════════════════════════════════════════════════════════════╣"
        CC 'Red'
        Write-Host "  ║  BULK ACTIONS ACROSS ALL MANAGERS                                     ║"
        Write-Host "  ║   [24] UPDATE    ALL [UPDATE]   flagged packages                      ║"
        Write-Host "  ║   [25] REMOVE    ALL [REMOVE]   flagged packages                      ║"
        Write-Host "  ║   [26] REMOVE    ALL [CONFLICT] flagged packages                      ║"
        Write-Host "  ║   [27] REINSTALL ALL [VULN]     flagged packages                      ║"
        CC 'DarkCyan'
        Write-Host "  ╠═══════════════════════════════════════════════════════════════════════╣"
        CC 'Gray'
        Write-Host "  ║   [0]  Exit                                                           ║"
        Write-Host "  ╚═══════════════════════════════════════════════════════════════════════╝"
        RC

        $c = Read-MenuChoice 27

        switch ($c) {
            1  { Start-ScanPicker }
            2  {
                if ($script:Scanned.Count -eq 0) { CC 'Red'; Write-Host "  Nothing scanned yet."; RC; Start-Sleep 1; break }
                if (Confirm-Action "Re-scan all: $($script:Scanned.Keys -join ', ')") {
                    foreach ($mgr in @($script:Scanned.Keys)) {
                        CC 'Gray'; Write-Host -NoNewline "  Scanning $mgr... "; RC
                        $script:Flags[$mgr] = $null
                        switch ($mgr) {
                            'pip'  {Scan-Pip}    'npm'  {Scan-Npm}    'yarn'  {Scan-Yarn}
                            'pnpm' {Scan-Pnpm}   'winget'{Scan-Winget}'choco' {Scan-Choco}
                            'brew' {Scan-Brew}   'apt'  {Scan-Apt}    'cargo' {Scan-Cargo}
                            'gem'  {Scan-Gem}    'go'   {Scan-Go}
                        }
                        CC 'Green'; Write-Host "done"; RC
                    }
                    CC 'Green'; Write-Host "`n  All re-scans complete. Press any key..."; RC
                    [void][Console]::ReadKey($true)
                }
            }
            3  { Menu-ManagerFlags 'pip'    { Show-PipArt    } }
            4  { Menu-ManagerFlags 'npm'    { Show-NpmArt    } }
            5  { Menu-ManagerFlags 'yarn'   { Show-YarnArt   } }
            6  { Menu-ManagerFlags 'pnpm'   { Show-PnpmArt   } }
            7  { Menu-ManagerFlags 'winget' { Show-WingetArt } }
            8  { Menu-ManagerFlags 'choco'  { Show-ChocoArt  } }
            9  { Menu-ManagerFlags 'brew'   { Show-BrewArt   } }
            10 { Menu-ManagerFlags 'apt'    { Show-AptArt    } }
            11 { Menu-ManagerFlags 'cargo'  { Show-CargoArt  } }
            12 {
                do {
                    Show-Banner; CC 'Cyan'; Write-Host "  gem / go — Pick one`n"; RC
                    CC 'White'; Write-Host "    [1]  gem/bundler"; Write-Host "    [2]  go modules"; CC 'Gray'; Write-Host "    [0]  Back"; RC
                    $s = Read-MenuChoice 2
                    switch ($s) {
                        1 { Menu-ManagerFlags 'gem' { Show-GemArt } }
                        2 { Menu-ManagerFlags 'go'  { Show-GoArt  } }
                        0 { break }
                    }
                    if ($s -eq 0) { break }
                } while ($true)
            }
            13 { Menu-Pip    }
            14 { Menu-Npm    }
            15 { Menu-Yarn   }
            16 { Menu-Pnpm   }
            17 { Menu-Winget }
            18 { Menu-Choco  }
            19 { Menu-Brew   }
            20 { Menu-Apt    }
            21 { Menu-Cargo  }
            22 { Menu-Gem    }
            23 { Menu-Go     }
            24 { Act-AllManagers 'UPDATE'   'UPDATE'    }
            25 { Act-AllManagers 'REMOVE'   'REMOVE'    }
            26 { Act-AllManagers 'CONFLICT' 'REMOVE'    }
            27 { Act-AllManagers 'VULN'     'REINSTALL' }
            0  {
                if (Confirm-Action "Exit PackageManager TUI?") {
                    Show-Banner
                    CC 'Green'
                    Write-Host ""
                    Write-Host "  ╔══════════════════════════════════════════╗"
                    Write-Host "  ║                                          ║"
                    Write-Host "  ║   All done. Stay patched. Stay safe.     ║"
                    Write-Host "  ║                                          ║"
                    Write-Host "  ╚══════════════════════════════════════════╝"
                    Write-Host ""
                    RC
                    exit 0
                }
            }
        }
    } while ($true)
}

# ══════════════════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════
Show-MainMenu


# SIG # Begin signature block
# MIIJIgYJKoZIhvcNAQcCoIIJEzCCCQ8CAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCCHXfoYy+GBcV6m
# rxDQ3mok1HJfAf0Rb+6yyJapGuREJqCCBWgwggVkMIIDTKADAgECAhBEeDXFXkLZ
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
# IgQgYZhKqFnn6iJquQlI7LpQPbJuNSWoklcC7lBhTGGuTeEwDQYJKoZIhvcNAQEB
# BQAEggIAiAFQDvKgtbNZqvYiDko87pW4pB1HiXX/ng74JT0Q2lftFzEmnUCpgm32
# PU17vTgokqj0sojF/sHgeTelUkejJ1WSagcgAs4nIT5NiSkcJNK5SmQPY/x+vzVa
# 9H7HNFFt8bGOcTF3gMTPMLSdVt/XAeJop3T5GrH8Drk+/PAxlZo3tOzfEgaPP4wn
# pjrsfUqMOqqRdTh5gMnBJ9NHQnWO9dFGVpj4/4BWz8duZgH48XN26kDGV2+oxdsQ
# u0YRgNGL+gbtZkEQABWRpxCmLfurb7oGNah4kgbWLcFogiNqYlHLDLK59r46sbH/
# AH/3do6+12PVEv8zixNEgZQbSWyMHQCqHf6vwczjYMDBadnkWOpMfQYiOckAcZQz
# V4uP/llTrt0mSTV755qNmCl+HvpdLtYDaLSaFxplVQzqx+GnB5Pm6o2rJmLuodQI
# qrXXSK0ZQRALFPSG9jX0tDtbXjyPV+MpymQ+3SFhbwg6JJTuNW5VHDdP8pP2M36D
# +WvQh+LDb3KVMEPNRydT30NMyT2us4q4jtPv+lKtriRVT7iG3mXYQ7eF4hez2ha/
# cFLlzXeB/vN6+Kdse3/gE9I+loOeJhfrloywoXdSoTj/jPPTFCNCmNMPBrL1YNX8
# OfVKR+P8psriQznzfWac+mwTYkZCJDuHIoKtBk7gzbSXrljLO4U=
# SIG # End signature block
