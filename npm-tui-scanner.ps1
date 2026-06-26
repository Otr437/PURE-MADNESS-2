<#
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2026 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-06-22 13:08:08
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  F595D12155B11E63BDCA5C57679A539EEE690378DA42023D65673FA95B9207B5
SHA-512:  8885270BB2481981E6010BEC463F261B80B0F732B7F12E30A5EB8522A982DBBD540E9EB272BF377FE528E9169255A8E2D55C44B3B72978868FFA43A80F438F49
MD5:      8FCFE5DFCA7D7E6CDE9E087C129FF03D
File Size: 53622 bytes

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
    Interactive PowerShell 7.6 TUI scanner for npm/PyPI supply chain threats 2026.
    Windows only. PS 7.6 on .NET 10 required.

.DESCRIPTION
    Covers ALL confirmed 2026 supply chain attacks including Mini Shai-Hulud (April-May 2026).

    ATTACK TIMELINE:
      March 31 2026  Axios RAT / WAVESHAPER.V2 (UNC1069/Sapphire Sleet DPRK)
                     npm: axios@1.14.1, 0.30.4, plain-crypto-js@4.2.1 + 2 scoped pkgs
                     C2: sfrclak[.]com:8000 / 142.11.206.73
                     Windows artifacts: %PROGRAMDATA%\wt.exe, system.bat, HKCU MicrosoftUpdate

      March 16 2026  GlassWorm React Native maintainer takeover
                     npm: react-native-international-phone-number 0.11.8-0.12.3
                     npm: react-native-country-select 0.3.91, 0.4.1, 0.4.2
                     C2: 45[.]32[.]150[.]251, 217[.]69[.]3[.]152

      March 19-27    TeamPCP wave 1 (Trivy, KICS, LiteLLM, Telnyx)
                     CVE-2026-33634 CVSS 9.4

      April 22 2026  @bitwarden/cli@2026.4.0 - 93 minutes live, Trusted Publishing abuse
                     "Shai-Hulud: The Third Coming" in exfil repos

      April 29 2026  Mini Shai-Hulud Wave 1 - SAP CAP packages (09:55-14:00 UTC)
                     @cap-js/sqlite@2.2.2, @cap-js/postgres@2.2.2
                     @cap-js/db-service@2.10.1, mbt@1.2.48
                     Bun runtime bypass, OIDC trusted publishing abuse
                     Exfil: creates GitHub repos tagged "A Mini Shai-Hulud has Appeared"

      April 30 2026  Mini Shai-Hulud / lightning (PyPI) - PyTorch Lightning 2.6.2, 2.6.3
                     Exfil repos: "EveryBoiWeBuildIsaWormBoi"

      May 11-12 2026 Mini Shai-Hulud Wave 3 - 373 malicious versions, 169 npm packages
                     CVE-2026-45321 CVSS 9.6
                     @tanstack (42 pkgs), @uipath (66), @squawk (87), @mistralai
                     @opensearch-project/opensearch, @tallyui, @beproduct, intercom-client
                     PyPI: guardrails-ai@0.10.1, mistralai@2.4.6
                     C2: git-tanstack[.]com, getsession.org (Session messenger), GitHub dead drops
                     Exfil repos: "Shai-Hulud: Here We Go Again", "PUSH UR T3MPRR"

      May 14 2026    node-ipc compromise - 3.35M monthly downloads
                     Hidden in node-ipc.cjs CommonJS bundle

    MINI SHAI-HULUD DETECTION (Windows):
      router_init.js, router_runtime.js, tanstack_runner.js, setup.mjs in package dirs
      .claude\setup.mjs or .vscode\setup.mjs in any repo
      %LOCALAPPDATA%\gh-token-monitor\ or Startup\gh-token-monitor
      GitHub repos with "A Mini Shai-Hulud has Appeared" or "PUSH UR T3MPRR"
      Commits starting with "OhNoWhatsGoingOnWithGitHub:"
      Orphaned commit ref in optionalDependencies: github:tanstack/router#79ac49ee

    !! CRITICAL WORM WARNING !!
      Do NOT revoke npm/GitHub tokens until the machine is ISOLATED.
      The worm monitors for token revocation and triggers rm -rf ~ (destructive payload).
      ISOLATE FIRST. Then image the drive. Then rotate credentials.

    STRICT: NO AUTO ACTIONS. Every npm command requires 'y' confirmation.

.EXAMPLE
    PS C:\project> pwsh -File .\npm-tui-scanner.ps1

.INPUTS
    None.

.OUTPUTS
    Scan reports exported to npm-scan-report-TIMESTAMP.json or .csv

.NOTES
    Version:      4.0.0
    Date:         2026-05-15
    Requires:     PowerShell 7.6.0 on .NET 10 LTS  (Windows only)
    Dependencies: npm, node in PATH
    Attribution:  TeamPCP / PCPcat / DeadCatx3 / ShellForce / CipherForce

.LINK
    https://snyk.io/blog/tanstack-npm-packages-compromised/

.LINK
    https://onapsis.com/blog/sap-cap-mini-shai-hulud-supply-chain-attack/

.LINK
    https://www.wiz.io/blog/mini-shai-hulud-strikes-again-tanstack-more-npm-packages-compromised

.COMPONENT
    npm supply chain security, incident response, IOC scanning, remediation

.ROLE
    Security Engineer, DevSecOps, Incident Responder

.FUNCTIONALITY
    Supply chain threat detection, RAT artifact scanning, IOC database management, guided remediation
#>

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Supply Chain Scanner 2026 v4 [Mini Shai-Hulud] - Windows PS7.6/.NET10'

$R  = $PSStyle.Reset
$CR = $PSStyle.Foreground.FromRgb(220,20,60)
$OR = $PSStyle.Foreground.FromRgb(255,140,0)
$YL = $PSStyle.Foreground.FromRgb(255,215,0)
$GR = $PSStyle.Foreground.FromRgb(0,255,127)
$CY = $PSStyle.Foreground.FromRgb(0,206,209)
$DM = $PSStyle.Foreground.FromRgb(100,116,139)
$WH = $PSStyle.Foreground.FromRgb(226,232,240)
$BD = $PSStyle.Bold

function Get-SevColor([string]$s) {
    switch ($s) { 'CRITICAL'{return $CR} 'HIGH'{return $OR} 'MEDIUM'{return $YL} default{return $DM} }
}
function Get-SevIcon([string]$s) {
    switch ($s) { 'CRITICAL'{return "${CR}${BD}[CRIT]${R}"} 'HIGH'{return "${OR}${BD}[HIGH]${R}"} 'MEDIUM'{return "${YL}[MED ]${R}"} default{return "${DM}[INFO]${R}"} }
}
function Get-InferredSev([PSCustomObject]$p) {
    if ($p.PSObject.Properties.Name -contains 'severity' -and $p.severity) { return $p.severity }
    if ($p.category -match 'MiniShaiHulud|Bitwarden|TeamPCP|Axios-RAT') { return 'CRITICAL' }
    if ($p.category -match 'GlassWorm|ReactNative') { return 'HIGH' }
    if ($p.category -match 'Carryover|Typosquat')   { return 'MEDIUM' }
    return 'HIGH'
}
function Write-Section([string]$t) {
    Write-Host "`n  ${DM}$('─'*68)${R}`n  ${CY}${BD}>> ${t}${R}`n  ${DM}$('─'*68)${R}`n"
}
function Confirm-Action([string]$m) {
    Write-Host "`n  ${YL}${BD}!! ${m}${R}"
    return ((Read-Host "  Type 'y' to confirm (anything else = NO)") -eq 'y')
}
function Invoke-Npm([string[]]$a) {
    try { return (& npm @a 2>&1) -join "`n" }
    catch { return "ERROR: $($_.Exception.Message)" }
}
function Get-AllDeps([PSCustomObject]$node,[System.Collections.Generic.List[PSCustomObject]]$list) {
    if ($null -eq $node) { return }
    foreach ($p in $node.PSObject.Properties) {
        $list.Add([PSCustomObject]@{name=$p.Name;ver=$p.Value.version})
        if ($p.Value.dependencies) { Get-AllDeps $p.Value.dependencies $list }
    }
}

$FlaggedFile = Join-Path (Get-Location) 'flagged-packages.json'

$InitialFlagged = @(
    # ── Axios RAT March 31 2026 ───────────────────────────────────────────────
    [PSCustomObject]@{pkg='axios';ver='1.14.1';severity='CRITICAL';category='March-Axios-RAT';safe='1.14.0'
        c2='sfrclak[.]com:8000 / 142.11.206.73'
        remediation='npm install axios@1.14.0 --save-exact. Check wt.exe, system.bat, HKCU MicrosoftUpdate. Rotate all creds.'
        desc='Maintainer hijacked->ifstap@proton.me. SILKBELL dropper->WAVESHAPER.V2. Windows: pwsh->%PROGRAMDATA%\wt.exe, HKCU MicrosoftUpdate. UNC1069/Sapphire Sleet DPRK.'},
    [PSCustomObject]@{pkg='axios';ver='0.30.4';severity='CRITICAL';category='March-Axios-RAT';safe='0.30.3'
        c2='sfrclak[.]com:8000';remediation='npm install axios@0.30.3 --save-exact. Rotate creds.'
        desc='Legacy branch. Same SILKBELL/WAVESHAPER.V2 chain.'},
    [PSCustomObject]@{pkg='plain-crypto-js';ver='4.2.1';severity='CRITICAL';category='March-Axios-RAT';safe=$null
        c2='sfrclak[.]com:8000'
        remediation='No safe version. Remove. Check wt.exe, system.bat, registry. Rotate ALL creds. Rebuild.'
        desc='SILKBELL dropper. postinstall->C2->RAT. Self-erasing. Dir existence in node_modules = dropper ran.'},
    [PSCustomObject]@{pkg='@qqbrowser/openclaw-qbot';ver='0.0.130';severity='CRITICAL';category='March-Axios-RAT';safe=$null
        c2='sfrclak[.]com:8000';remediation='No safe version. Remove entirely.'
        desc='Ships tampered axios@1.14.1 with plain-crypto-js injected.'},
    [PSCustomObject]@{pkg='@shadanai/openclaw';ver='1.0.0';severity='CRITICAL';category='March-Axios-RAT';safe=$null
        c2='sfrclak[.]com:8000';remediation='No safe version. Remove entirely.'
        desc='Vendors plain-crypto-js dropper directly.'},

    # ── GlassWorm March 16 2026 ───────────────────────────────────────────────
    [PSCustomObject]@{pkg='react-native-international-phone-number';ver='0.11.8';severity='HIGH';category='March-GlassWorm';safe='0.11.7'
        c2='45[.]32[.]150[.]251 / 217[.]69[.]3[.]152';remediation='npm install react-native-international-phone-number@0.11.7 --save-exact. Rotate crypto wallet creds.'
        desc='GlassWorm March 16. preinstall. Skips Russian locales. Crypto wallet exfil via Solana C2.'},
    [PSCustomObject]@{pkg='react-native-international-phone-number';ver='0.12.1';severity='HIGH';category='March-GlassWorm';safe='0.11.7'
        c2='45[.]32[.]150[.]251';remediation='Pin to 0.11.7.';desc='GlassWorm additional version.'},
    [PSCustomObject]@{pkg='react-native-international-phone-number';ver='0.12.2';severity='HIGH';category='March-GlassWorm';safe='0.11.7'
        c2='45[.]32[.]150[.]251';remediation='Pin to 0.11.7.';desc='GlassWorm additional version.'},
    [PSCustomObject]@{pkg='react-native-international-phone-number';ver='0.12.3';severity='HIGH';category='March-GlassWorm';safe='0.11.7'
        c2='45[.]32[.]150[.]251';remediation='Pin to 0.11.7.';desc='GlassWorm additional version.'},
    [PSCustomObject]@{pkg='react-native-country-select';ver='0.3.91';severity='HIGH';category='March-GlassWorm';safe='0.3.9'
        c2='45[.]32[.]150[.]251';remediation='npm install react-native-country-select@0.3.9 --save-exact.'
        desc='GlassWorm March 16. Skips Russian locales.'},
    [PSCustomObject]@{pkg='react-native-country-select';ver='0.4.1';severity='HIGH';category='March-GlassWorm';safe='0.4.0'
        c2='45[.]32[.]150[.]251';remediation='Pin to 0.4.0.';desc='GlassWorm additional version.'},
    [PSCustomObject]@{pkg='react-native-country-select';ver='0.4.2';severity='HIGH';category='March-GlassWorm';safe='0.4.0'
        c2='45[.]32[.]150[.]251';remediation='Pin to 0.4.0.';desc='GlassWorm additional version. Was @latest at discovery.'},

    # ── TeamPCP March 2026 ────────────────────────────────────────────────────
    [PSCustomObject]@{pkg='trivy';ver='0.69.4';severity='CRITICAL';category='March-TeamPCP';safe='0.69.3'
        c2='checkmarx[.]zone';remediation='Downgrade to v0.69.3. Pin Actions to SHA. Check %APPDATA%\sysmon. Audit CI March 19-20. CVE-2026-33634.'
        desc='TeamPCP March 19. Infostealer. Force-pushed 76/77 tags. CVE-2026-33634 CVSS 9.4.'},
    [PSCustomObject]@{pkg='kics-github-action';ver='PRE-v2.1.20';severity='CRITICAL';category='March-TeamPCP';safe='v2.1.20+'
        c2='checkmarx[.]zone';remediation='Update to v2.1.20+. Audit CI March 23 12:58-16:50 UTC. Check for tpcp-docs-* GitHub repos. Rotate GitHub tokens.'
        desc='TeamPCP compromised KICS March 23 12:58-16:50 UTC.'},

    # ── Bitwarden April 22 2026 ───────────────────────────────────────────────
    [PSCustomObject]@{pkg='@bitwarden/cli';ver='2026.4.0';severity='CRITICAL';category='April-MiniShaiHulud-Wave1';safe='2025.12.0'
        c2='GitHub dead drops / git-tanstack[.]com'
        remediation='Pin to 2025.12.0. ISOLATE machine before revoking tokens. Check for gh-token-monitor in Startup. Check .claude\ and .vscode\ for setup.mjs. Audit GitHub repos for Dune-themed names. Worm triggers rm-rf on token revocation.'
        desc='TeamPCP April 22. 93 minutes live. Trusted Publishing abuse. Self-propagating worm. Exfil repos: "Shai-Hulud: The Third Coming". First Trusted Publishing npm supply chain attack documented.'},

    # ── Mini Shai-Hulud Wave 1 — SAP CAP April 29 2026 ───────────────────────
    [PSCustomObject]@{pkg='@cap-js/sqlite';ver='2.2.2';severity='CRITICAL';category='April-MiniShaiHulud-SAP';safe='2.2.1'
        c2='GitHub repos "A Mini Shai-Hulud has Appeared"'
        remediation='npm install @cap-js/sqlite@2.2.1 --save-exact. Window: 09:55-14:00 UTC April 29. ISOLATE before revoking tokens. Check for OhNoWhatsGoingOnWithGitHub commits. Check .claude\setup.mjs and .vscode\tasks.json.'
        desc='Mini Shai-Hulud Wave 1 April 29. Bun runtime bypass. OIDC trusted publishing abuse. Exfils to GitHub repos. Worm propagates via stolen npm/GitHub tokens. Triggers rm-rf if tokens revoked while running. SAP Note 3747787.'},
    [PSCustomObject]@{pkg='@cap-js/postgres';ver='2.2.2';severity='CRITICAL';category='April-MiniShaiHulud-SAP';safe='2.2.1'
        c2='GitHub repos';remediation='npm install @cap-js/postgres@2.2.1 --save-exact. Same as sqlite remediation.'
        desc='Mini Shai-Hulud Wave 1 April 29. Same Bun payload as sqlite.'},
    [PSCustomObject]@{pkg='@cap-js/db-service';ver='2.10.1';severity='CRITICAL';category='April-MiniShaiHulud-SAP';safe='2.10.0'
        c2='GitHub repos';remediation='npm install @cap-js/db-service@2.10.0 --save-exact. Same remediation.'
        desc='Mini Shai-Hulud Wave 1 April 29. Same Bun payload.'},
    [PSCustomObject]@{pkg='mbt';ver='1.2.48';severity='CRITICAL';category='April-MiniShaiHulud-SAP';safe='1.2.47'
        c2='GitHub repos';remediation='npm install mbt@1.2.47 --save-exact. cloudmtabot token compromised.'
        desc='Mini Shai-Hulud Wave 1 April 29. cloudmtabot automation token used to publish. 570k weekly downloads.'},

    # ── Mini Shai-Hulud Wave 3 — TanStack May 11 2026 ────────────────────────
    [PSCustomObject]@{pkg='@tanstack/react-router';ver='MALICIOUS-MAY11';severity='CRITICAL';category='May-MiniShaiHulud-TanStack';safe='pin-to-SHA'
        c2='git-tanstack[.]com / getsession.org / GitHub dead drops'
        remediation='!! ISOLATE machine first. Do NOT revoke tokens until isolated. Check for gh-token-monitor service: Get-Service gh-token-monitor. Check .claude\setup.mjs and .vscode\setup.mjs. Search for router_init.js, tanstack_runner.js, setup.mjs. Then rotate npm tokens, GitHub PATs, OIDC trusts, AWS, Vault, k8s SA tokens. CVE-2026-45321.'
        desc='Mini Shai-Hulud Wave 3 May 11 19:20-19:26 UTC. 12M weekly downloads. OIDC token extracted from GitHub runner /proc memory. 84 malicious versions published with valid SLSA provenance. Triple C2: git-tanstack.com + Session messenger + GitHub dead drops. Exfil repos: "Shai-Hulud: Here We Go Again". Worm triggers rm-rf on token revocation. CVE-2026-45321 CVSS 9.6.'},
    [PSCustomObject]@{pkg='@tanstack/start';ver='MALICIOUS-MAY11';severity='CRITICAL';category='May-MiniShaiHulud-TanStack';safe='pin-to-SHA'
        c2='git-tanstack[.]com';remediation='Same as react-router. ISOLATE before revoking.';desc='Mini Shai-Hulud TanStack May 11.'},
    [PSCustomObject]@{pkg='@tanstack/router-devtools';ver='MALICIOUS-MAY11';severity='CRITICAL';category='May-MiniShaiHulud-TanStack';safe='pin-to-SHA'
        c2='git-tanstack[.]com';remediation='Same as react-router. ISOLATE before revoking.';desc='Mini Shai-Hulud TanStack May 11.'},
    [PSCustomObject]@{pkg='@uipath/apollo-core';ver='MALICIOUS-MAY11';severity='CRITICAL';category='May-MiniShaiHulud-UiPath';safe='pin-to-clean'
        c2='git-tanstack[.]com / getsession.org'
        remediation='ISOLATE first. Check for gh-token-monitor. Check setup.mjs in node_modules. Rotate all tokens. Note: @uipath payload had bug making malware non-functional in initial release but updated payload published May 13.'
        desc='Mini Shai-Hulud UiPath May 11. Preinstall node setup.mjs downloads Bun runtime. Same C2 as TanStack. Updated working payload released May 13.'},
    [PSCustomObject]@{pkg='@mistralai/mistralai';ver='2.4.6';severity='CRITICAL';category='May-MiniShaiHulud-Mistral';safe='2.4.5'
        c2='git-tanstack[.]com / 83[.]142[.]209[.]194 / getsession.org'
        remediation='npm install @mistralai/mistralai@2.4.5 --save-exact. ISOLATE first. Also check PyPI mistralai==2.4.6.'
        desc='Mini Shai-Hulud Mistral May 11. Credential stealer + Linux-only execution. Skips Russian locales. Also on PyPI.'},
    [PSCustomObject]@{pkg='@opensearch-project/opensearch';ver='MALICIOUS-MAY11';severity='CRITICAL';category='May-MiniShaiHulud-OpenSearch';safe='pin-to-clean'
        c2='git-tanstack[.]com';remediation='ISOLATE first. Pin to clean version. Rotate all tokens.'
        desc='Mini Shai-Hulud OpenSearch May 11-12.'},
    [PSCustomObject]@{pkg='intercom-client';ver='MALICIOUS-MAY12';severity='CRITICAL';category='May-MiniShaiHulud-Wave3';safe='pin-to-clean'
        c2='git-tanstack[.]com';remediation='ISOLATE first. Check lockfile for May 12 version. Rotate tokens.'
        desc='Mini Shai-Hulud Wave 3 collateral. Self-propagated via stolen maintainer tokens.'},
    [PSCustomObject]@{pkg='node-ipc';ver='MALICIOUS-MAY14';severity='CRITICAL';category='May-MiniShaiHulud-NodeIPC';safe='pin-to-clean'
        c2='git-tanstack[.]com'
        remediation='ISOLATE first. Payload hidden inside node-ipc.cjs CommonJS bundle. Check lockfile. 3.35M monthly downloads exposure. Rotate all tokens.'
        desc='node-ipc May 14. Malicious payload hidden in CommonJS bundle node-ipc.cjs. 3.35M monthly downloads.'},

    # ── SANDWORM_MODE Feb 2026 ────────────────────────────────────────────────
    [PSCustomObject]@{pkg='claud-code';ver='0.2.1';severity='CRITICAL';category='Feb-SANDWORM_MODE';safe=$null
        c2='DGA';remediation='No safe version. Remove. Check .claude\settings.json. Check .github\workflows\quality.yml. Rotate npm/GitHub tokens.'
        desc='SANDWORM_MODE Feb. Typosquat of claude-code. Propagates into all package.json. Injects quality.yml. Poisons MCP.'},
    [PSCustomObject]@{pkg='cloude-code';ver='0.2.1';severity='CRITICAL';category='Feb-SANDWORM_MODE';safe=$null
        c2='DGA';remediation='No safe version. Remove.';desc='SANDWORM_MODE AI toolchain typosquat.'},
    [PSCustomObject]@{pkg='cloude';ver='0.3.0';severity='CRITICAL';category='Feb-SANDWORM_MODE';safe=$null
        c2='DGA';remediation='No safe version. Remove.';desc='SANDWORM_MODE worm component.'},
    [PSCustomObject]@{pkg='secp256';ver='1.0.0';severity='CRITICAL';category='Feb-SANDWORM_MODE';safe=$null
        c2='DGA';remediation='No safe version. Remove. Rotate all crypto keys.';desc='SANDWORM_MODE secp256k1 impersonation.'},
    [PSCustomObject]@{pkg='suport-color';ver='1.0.1';severity='HIGH';category='Feb-SANDWORM_MODE';safe=$null
        c2='DGA';remediation='No safe version. Remove. Legitimate: supports-color.';desc='Typosquat of supports-color. 163KB zlib+XOR payload.'},

    # ── Carryovers ────────────────────────────────────────────────────────────
    [PSCustomObject]@{pkg='chalk';ver='5.6.1';severity='MEDIUM';category='ShaiHulud-Carryover';safe='5.3.0'
        c2='unknown';remediation='npm install chalk@5.3.0 --save-exact.';desc='2025 Shai-Hulud carryover. Crypto stealer.'},
    [PSCustomObject]@{pkg='debug';ver='4.4.2';severity='MEDIUM';category='ShaiHulud-Carryover';safe='4.3.4'
        c2='unknown';remediation='npm install debug@4.3.4 --save-exact.';desc='2025 Shai-Hulud carryover. Secret exfil.'}
)

function Load-Flagged {
    if (Test-Path $FlaggedFile) {
        try { return Get-Content $FlaggedFile -Raw | ConvertFrom-Json }
        catch { Write-Host "  ${YL}WARN: Could not load $FlaggedFile${R}" }
    }
    return $InitialFlagged
}
function Save-Flagged([array]$list) { $list | ConvertTo-Json -Depth 10 | Set-Content $FlaggedFile -Encoding utf8 }
$global:Flagged = Load-Flagged

function Show-Banner {
    Clear-Host
    Write-Host ""
    Write-Host "${CR}${BD}  ███╗   ██╗██████╗ ███╗   ███╗    ████████╗██╗   ██╗██╗${R}"
    Write-Host "${CR}${BD}  ████╗  ██║██╔══██╗████╗ ████║       ██╔══╝██║   ██║██║${R}"
    Write-Host "${CR}  ██╔██╗ ██║██████╔╝██╔████╔██║       ██║   ██║   ██║██║${R}"
    Write-Host "${CR}  ██║╚██╗██║██╔═══╝ ██║╚██╔╝██║       ██║   ██║   ██║██║${R}"
    Write-Host "${DM}  ██║ ╚████║██║     ██║ ╚═╝ ██║       ██║   ╚██████╔╝██║${R}"
    Write-Host "${DM}  ╚═╝  ╚═══╝╚═╝     ╚═╝     ╚═╝       ╚═╝    ╚═════╝ ╚═╝${R}"
    Write-Host ""
    Write-Host "${YL}  ███████╗ ██████╗ █████╗ ███╗   ██╗███╗   ██╗███████╗██████╗${R}"
    Write-Host "${YL}  ██╔════╝██╔════╝██╔══██╗████╗  ██║████╗  ██║██╔════╝██╔══██╗${R}"
    Write-Host "${YL}  ███████╗██║     ███████║██╔██╗ ██║██╔██╗ ██║█████╗  ██████╔╝${R}"
    Write-Host "${YL}  ╚════██║██║     ██╔══██║██║╚██╗██║██║╚██╗██║██╔══╝  ██╔══██╗${R}"
    Write-Host "${DM}  ███████║╚██████╗██║  ██║██║ ╚████║██║ ╚████║███████╗██║  ██║${R}"
    Write-Host "${DM}  ╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝${R}"
    Write-Host ""
    Write-Host "  ${CR}╔═══════════════════════════════════════════════════════════════════╗${R}"
    Write-Host "  ${CR}║  !! SUPPLY CHAIN SCANNER 2026 v4  *  MINI SHAI-HULUD EDITION  !! ║${R}"
    Write-Host "  ${OR}║  Axios/RAT * GlassWorm * TeamPCP * Bitwarden * MiniShaiHulud      ║${R}"
    Write-Host "  ${CR}║  !! ISOLATE BEFORE REVOKING TOKENS -- WORM TRIGGERS rm-rf !!      ║${R}"
    Write-Host "  ${YL}║  NO AUTO ACTIONS  *  YES/NO ONLY  *  PS 7.6 / .NET 10  WINDOWS    ║${R}"
    Write-Host "  ${CR}╚═══════════════════════════════════════════════════════════════════╝${R}"
    Write-Host ""
    Write-Host "  ${DM}PS $($PSVersionTable.PSVersion)  |  .NET $([System.Environment]::Version)  |  $(Get-Date -Format 'yyyy-MM-dd HH:mm')  |  IOC DB: $($global:Flagged.Count) entries${R}"
    Write-Host ""
}

function Invoke-SafetyCheck {
    Show-Banner
    Write-Section "STARTUP SAFETY CHECK - ALL 2026 WINDOWS ARTIFACTS"
    Write-Host "  ${CR}${BD}!! CRITICAL: Do NOT revoke tokens if worm is running. ISOLATE first.${R}`n"
    $c = $false

    Write-Host "  ${DM}── MINI SHAI-HULUD (April-May 2026) ─────────────────────────────────${R}"
    # Worm payload files in common locations
    foreach ($dir in @("$HOME\.claude","$HOME\.vscode",".\node_modules")) {
        foreach ($f in @('setup.mjs','router_init.js','router_runtime.js','tanstack_runner.js')) {
            $fp = Join-Path $dir $f
            if (Test-Path $fp) { Write-Host "  ${CR}${BD}!! FOUND worm file: $fp${R}"; $c=$true }
        }
    }
    # gh-token-monitor persistence
    foreach ($p in @("$env:LOCALAPPDATA\gh-token-monitor","$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\gh-token-monitor.exe")) {
        Write-Host "  ${DM}  $p${R}"
        if (Test-Path $p) { Write-Host "  ${CR}${BD}!! FOUND: gh-token-monitor  --  MINI SHAI-HULUD PERSISTENCE${R}"; $c=$true }
        else { Write-Host "  ${GR}  OK${R}" }
    }
    # Lockfile check for Mini Shai-Hulud orphaned commit
    if (Test-Path 'package-lock.json') {
        $lock = Get-Content 'package-lock.json' -Raw
        if ($lock -match '79ac49ee') { Write-Host "  ${CR}${BD}!! FOUND orphaned tanstack commit ref in lockfile  --  CONFIRMED INFECTION${R}"; $c=$true }
        else { Write-Host "  ${GR}  OK: No Mini Shai-Hulud orphaned commit in lockfile${R}" }
    }
    # /tmp equivalent - check temp
    $tmp = [System.IO.Path]::GetTempPath()
    foreach ($tf in @('tmp.ts018051808.lock')) {
        if (Test-Path (Join-Path $tmp $tf)) { Write-Host "  ${CR}${BD}!! FOUND: $tf in TEMP  --  MINI SHAI-HULUD ACTIVE${R}"; $c=$true }
    }
    # GitHub repo IOC check (search DNS cache for git-tanstack)
    Write-Host "  ${DM}  DNS cache: git-tanstack[.]com / getsession.org (Mini Shai-Hulud C2)${R}"
    try {
        if (Get-DnsClientCache -ErrorAction SilentlyContinue | Where-Object { $_.Entry -match 'git-tanstack|getsession' }) {
            Write-Host "  ${CR}${BD}!! Mini Shai-Hulud C2 in DNS cache${R}"; $c=$true
        } else { Write-Host "  ${GR}  OK${R}" }
    } catch { Write-Host "  ${OR}  WARN: DNS check failed${R}" }
    # IDE persistence
    Write-Host "  ${DM}  .vscode\tasks.json (IDE persistence via runOn:folderOpen)${R}"
    if (Test-Path '.vscode\tasks.json') {
        $vt = Get-Content '.vscode\tasks.json' -Raw -ErrorAction SilentlyContinue
        if ($vt -match 'folderOpen|setup\.mjs|router_runtime') { Write-Host "  ${CR}${BD}!! SUSPICIOUS .vscode\tasks.json  --  IDE PERSISTENCE${R}"; $c=$true }
        else { Write-Host "  ${YL}  WARN: .vscode\tasks.json exists - review manually${R}" }
    } else { Write-Host "  ${GR}  OK${R}" }

    Write-Host "`n  ${DM}── AXIOS RAT / WAVESHAPER.V2 (March 31 2026) ────────────────────────${R}"
    foreach ($p in @("$env:PROGRAMDATA\wt.exe","$env:PROGRAMDATA\system.bat")) {
        Write-Host "  ${DM}  $p${R}"
        if (Test-Path $p) { Write-Host "  ${CR}${BD}!! FOUND  --  AXIOS RAT ARTIFACT${R}"; $c=$true }
        else { Write-Host "  ${GR}  OK${R}" }
    }
    try {
        $rv = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'MicrosoftUpdate' -ErrorAction SilentlyContinue
        if ($rv) { Write-Host "  ${CR}${BD}!! HKCU MicrosoftUpdate key found  --  RAT PERSISTENCE ACTIVE${R}"; $c=$true }
        else { Write-Host "  ${GR}  OK: MicrosoftUpdate key not found${R}" }
    } catch { Write-Host "  ${OR}  WARN: Registry check failed${R}" }
    if (Test-Path (Join-Path (Get-Location) 'node_modules\plain-crypto-js')) {
        Write-Host "  ${CR}${BD}!! plain-crypto-js dir exists  --  DROPPER RAN${R}"; $c=$true
    } else { Write-Host "  ${GR}  OK: plain-crypto-js dir not present${R}" }
    if (Test-Path 'package-lock.json') {
        $lock = Get-Content 'package-lock.json' -Raw
        if ($lock -match '1\.14\.1|0\.30\.4') { Write-Host "  ${CR}${BD}!! Compromised axios version in lockfile${R}"; $c=$true }
        else { Write-Host "  ${GR}  OK: No compromised axios in lockfile${R}" }
    }
    try {
        if (Get-DnsClientCache -ErrorAction SilentlyContinue | Where-Object { $_.Entry -like '*sfrclak*' }) {
            Write-Host "  ${CR}${BD}!! sfrclak.com in DNS cache  --  C2 CONTACTED${R}"; $c=$true
        } else { Write-Host "  ${GR}  OK${R}" }
    } catch {}

    Write-Host "`n  ${DM}── SANDWORM_MODE / TEAMPCP / GLASSWORM ──────────────────────────────${R}"
    if (Test-Path '.github\workflows\quality.yml') { Write-Host "  ${CR}${BD}!! quality.yml  --  SANDWORM CI INJECTION${R}"; $c=$true }
    else { Write-Host "  ${GR}  OK: quality.yml not found${R}" }
    foreach ($mp in @("$HOME\.claude\settings.json","$HOME\.claude.json")) {
        if ((Test-Path $mp) -and ((Get-Content $mp -Raw -ErrorAction SilentlyContinue) -match 'official334|javaorg|SANDWORM|sfrclak')) {
            Write-Host "  ${CR}${BD}!! Suspicious MCP: $mp${R}"; $c=$true
        }
    }
    try {
        if (Get-DnsClientCache -ErrorAction SilentlyContinue | Where-Object { $_.Entry -match '45\.32\.150|217\.69\.3|checkmarx\.zone|83\.142\.209' }) {
            Write-Host "  ${CR}${BD}!! Known C2 in DNS cache${R}"; $c=$true
        } else { Write-Host "  ${GR}  OK${R}" }
    } catch {}

    Write-Host ""
    if ($c) {
        Write-Host "  ${CR}╔═══════════════════════════════════════════════════════════════════╗${R}"
        Write-Host "  ${CR}║  !! COMPROMISE INDICATORS FOUND                                   ║${R}"
        Write-Host "  ${CR}╠═══════════════════════════════════════════════════════════════════╣${R}"
        Write-Host "  ${CR}║  1. !! ISOLATE MACHINE FIRST before revoking ANY tokens          ║${R}"
        Write-Host "  ${CR}║     Worm triggers rm-rf on token revocation detection            ║${R}"
        Write-Host "  ${YL}║  2. Disconnect from network                                       ║${R}"
        Write-Host "  ${YL}║  3. Image drive for forensics                                     ║${R}"
        Write-Host "  ${YL}║  4. Remove gh-token-monitor from Startup                          ║${R}"
        Write-Host "  ${YL}║  5. Remove .claude\setup.mjs and .vscode\setup.mjs               ║${R}"
        Write-Host "  ${YL}║  6. THEN rotate: npm tokens, GitHub PATs, AWS/GCP/Azure,          ║${R}"
        Write-Host "  ${YL}║     CI/CD secrets, k8s tokens, vault tokens, OIDC trusts          ║${R}"
        Write-Host "  ${YL}║  7. Block C2 at firewall (see menu option 9)                      ║${R}"
        Write-Host "  ${YL}║  8. Audit GitHub repos for Dune-themed names                      ║${R}"
        Write-Host "  ${YL}║  9. Search GitHub for: OhNoWhatsGoingOnWithGitHub commits         ║${R}"
        Write-Host "  ${CR}╚═══════════════════════════════════════════════════════════════════╝${R}"
    } else {
        Write-Host "  ${GR}${BD}  OK: No compromise indicators found.${R}"
        Write-Host "  ${DM}  Self-erasing malware may leave no trace. Check lockfiles and CI logs.${R}"
    }
    Write-Host ""
    Read-Host "  Press Enter to continue to menu"
}

function Show-Flagged {
    Show-Banner; Write-Section "FULL IOC DATABASE ($($global:Flagged.Count) entries)"
    $cats = @('ALL') + ($global:Flagged | Select-Object -ExpandProperty category -Unique | Sort-Object)
    for ($i = 0; $i -lt $cats.Count; $i++) { Write-Host "  ${DM}$i. $($cats[$i])${R}" }
    $pick = Read-Host "  Filter by number or Enter for ALL"
    $list = if ($pick -match '^\d+$' -and [int]$pick -gt 0 -and [int]$pick -lt $cats.Count) {
        $global:Flagged | Where-Object { $_.category -eq $cats[[int]$pick] }
    } else { $global:Flagged }
    foreach ($e in $list) {
        $sc = Get-SevColor (Get-InferredSev $e)
        Write-Host "  $(Get-SevIcon (Get-InferredSev $e)) ${sc}${BD}[$($e.category)]${R} ${sc}$($e.pkg)@$($e.ver)${R}"
        Write-Host "  ${DM}     $($e.desc)${R}"
        if ($e.c2)          { Write-Host "  ${CR}     C2: $($e.c2)${R}" }
        if ($e.safe)        { Write-Host "  ${GR}     Safe: $($e.safe)${R}" }
        else                { Write-Host "  ${OR}     No safe version - remove entirely${R}" }
        if ($e.remediation) { Write-Host "  ${CY}     Fix: $($e.remediation)${R}" }
        Write-Host ""
    }
    Write-Host "  ${CY}  Shown: $($list.Count)${R}"; Read-Host "  Press Enter"
}

function Invoke-Scan([bool]$silent=$false) {
    if (-not $silent) { Show-Banner; Write-Section "SCAN FOR FLAGGED PACKAGES" }
    $found = [System.Collections.Generic.List[PSCustomObject]]::new()

    Write-Host "  ${CY}[1/4] Direct dependencies...${R}"
    $shallow = Invoke-Npm 'ls','--json','--depth=0'
    try {
        $direct = ($shallow | ConvertFrom-Json).dependencies
        foreach ($bad in $global:Flagged) {
            if ($direct -and $direct.PSObject.Properties.Name -contains $bad.pkg -and $direct.($bad.pkg).version -eq $bad.ver) {
                $found.Add([PSCustomObject]@{entry=$bad;depth='direct'})
            }
        }
    } catch { Write-Host "  ${OR}  WARN: npm ls parse issue${R}" }

    Write-Host "  ${CY}[2/4] Full tree...${R}"
    try {
        $dj = (Invoke-Npm 'ls','--json','--all') | ConvertFrom-Json
        $ad = [System.Collections.Generic.List[PSCustomObject]]::new()
        if ($dj.dependencies) { Get-AllDeps $dj.dependencies $ad }
        foreach ($bad in $global:Flagged) {
            if (($ad | Where-Object { $_.name -eq $bad.pkg -and $_.ver -eq $bad.ver }) -and
                -not ($found | Where-Object { $_.entry.pkg -eq $bad.pkg -and $_.entry.ver -eq $bad.ver })) {
                $found.Add([PSCustomObject]@{entry=$bad;depth='transitive'})
            }
        }
    } catch { Write-Host "  ${OR}  WARN: full tree parse issue${R}" }

    Write-Host "  ${CY}[3/4] Phantom dir check...${R}"
    foreach ($ph in @('plain-crypto-js','@cap-js/sqlite','@cap-js/postgres','@bitwarden/cli')) {
        $phDir = Join-Path (Get-Location) "node_modules\$ph"
        if (Test-Path $phDir) {
            # Check for Mini Shai-Hulud payload files
            foreach ($f in @('setup.mjs','router_init.js','router_runtime.js','tanstack_runner.js')) {
                if (Test-Path (Join-Path $phDir $f)) {
                    Write-Host "  ${CR}${BD}!! WORM FILE in node_modules: $ph\$f${R}"
                    $found.Add([PSCustomObject]@{entry=($global:Flagged|Where-Object{$_.pkg -eq $ph}|Select-Object -First 1);depth="worm-file-$f"})
                }
            }
        }
    }

    Write-Host "  ${CY}[4/4] Mini Shai-Hulud IOC file check...${R}"
    foreach ($loc in @('.','.\node_modules','.\.claude','.\.vscode')) {
        foreach ($f in @('setup.mjs','router_init.js','router_runtime.js','tanstack_runner.js')) {
            $fp = Join-Path $loc $f
            if (Test-Path $fp) { Write-Host "  ${CR}${BD}!! WORM FILE: $fp${R}"; $found.Add([PSCustomObject]@{entry=[PSCustomObject]@{pkg="worm-file:$f";ver='unknown';severity='CRITICAL';category='May-MiniShaiHulud';safe=$null;desc='Mini Shai-Hulud worm payload file';remediation='ISOLATE machine. Do not revoke tokens yet. Check gh-token-monitor.';c2='git-tanstack[.]com'};depth='worm-payload-file'}) }
        }
    }

    Write-Host ""
    if ($found.Count -eq 0) { Write-Host "  ${GR}${BD}  OK: No flagged packages detected.${R}" }
    else {
        Write-Host "  ${CR}${BD}  !! IOC MATCHES: $($found.Count) found${R}"
        foreach ($hit in $found) {
            if ($null -eq $hit.entry) { continue }
            $sc = Get-SevColor (Get-InferredSev $hit.entry)
            Write-Host "  $(Get-SevIcon (Get-InferredSev $hit.entry)) ${sc}$($hit.entry.pkg)@$($hit.entry.ver)  [$($hit.entry.category)]  depth:$($hit.depth)${R}"
            if ($hit.entry.remediation) { Write-Host "  ${CY}     FIX: $($hit.entry.remediation)${R}" }
            Write-Host ""
        }
    }
    if (-not $silent) { Read-Host "  Press Enter" }
    return ,$found
}

function Invoke-RemediationMenu {
    while ($true) {
        Show-Banner; Write-Section "REMEDIATION MENU"
        Write-Host "  ${CR}${BD}!! ISOLATE MACHINE BEFORE REVOKING TOKENS -- WORM TRIGGERS rm-rf !!${R}`n"
        $i = 0
        foreach ($f in $global:Flagged) {
            $sc = Get-SevColor (Get-InferredSev $f)
            Write-Host "  $(Get-SevIcon (Get-InferredSev $f)) ${sc}[$($i+1)] $($f.pkg)@$($f.ver)${R}  ${DM}[$($f.category)]${R}"
            $i++
        }
        Write-Host ""
        Write-Host "  ${YL}  [A] Auto-fix all with safe versions${R}"
        Write-Host "  ${YL}  [B] Show package.json overrides block${R}"
        Write-Host "  ${CR}  [I] Mini Shai-Hulud isolation + cleanup steps${R}"
        Write-Host "  ${CY}  [E] Export remediation report${R}"
        Write-Host "  ${CR}  [C] Credential rotation checklist${R}"
        Write-Host "  ${CR}  [F] Firewall block list${R}"
        Write-Host "  ${DM}  [0] Back${R}`n"
        $ch = Read-Host "  Number or letter"
        switch ($ch.ToUpper()) {
            'A' {
                $fx = $global:Flagged | Where-Object { $_.safe }
                if (Confirm-Action "Pin all $($fx.Count) packages with safe versions?") {
                    foreach ($f in $fx) {
                        if (Confirm-Action "npm install $($f.pkg)@$($f.safe) --save-exact") {
                            Write-Host (Invoke-Npm 'install',"$($f.pkg)@$($f.safe)",'--save-exact')
                            Write-Host "  ${GR}  Done: $($f.pkg)@$($f.safe)${R}"
                        }
                    }
                }
                Read-Host "  Press Enter"
            }
            'B' {
                Show-Banner; Write-Section "PACKAGE.JSON OVERRIDES"
                Write-Host "  ${CY}  `"overrides`": {${R}"
                ($global:Flagged | Where-Object { $_.safe }) | ForEach-Object { Write-Host "  ${WH}    `"$($_.pkg)`": `"$($_.safe)`",${R}" }
                Write-Host "  ${CY}  }${R}"; Read-Host "  Press Enter"
            }
            'I' {
                Show-Banner; Write-Section "MINI SHAI-HULUD ISOLATION + CLEANUP"
                Write-Host "  ${CR}${BD}STEP 1: ISOLATE BEFORE ANYTHING ELSE${R}"
                Write-Host "  ${WH}  Disconnect network adapter now${R}"
                Write-Host "  ${WH}  Do NOT revoke tokens until step 4${R}`n"
                Write-Host "  ${YL}STEP 2: FIND AND STOP WORM${R}"
                Write-Host "  ${WH}  Get-Process | Where Name -match 'bun|tanstack_runner|gh-token'${R}"
                Write-Host "  ${WH}  Stop-Process -Name bun -Force -ErrorAction SilentlyContinue${R}`n"
                Write-Host "  ${YL}STEP 3: REMOVE PERSISTENCE${R}"
                Write-Host "  ${WH}  Remove-Item `"$env:LOCALAPPDATA\gh-token-monitor`" -Recurse -Force -EA SilentlyContinue${R}"
                Write-Host "  ${WH}  Remove-Item `"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\gh-token-monitor*`" -Force -EA SilentlyContinue${R}"
                Write-Host "  ${WH}  Remove-Item `".\.claude\setup.mjs`",`".\.vscode\setup.mjs`",`".\.vscode\tasks.json`" -Force -EA SilentlyContinue${R}"
                Write-Host "  ${WH}  Get-ChildItem -Recurse -Filter 'router_init.js','router_runtime.js','tanstack_runner.js','setup.mjs' | Remove-Item -Force${R}`n"
                Write-Host "  ${CR}STEP 4: NOW ROTATE CREDENTIALS${R}"
                Write-Host "  ${WH}  npm token revoke + reissue${R}"
                Write-Host "  ${WH}  GitHub: github.com/settings/tokens${R}"
                Write-Host "  ${WH}  OIDC trusts: review all workflow permissions${R}"
                Write-Host "  ${WH}  AWS/GCP/Azure creds, k8s SA tokens, Vault tokens${R}`n"
                Write-Host "  ${YL}STEP 5: AUDIT${R}"
                Write-Host "  ${WH}  Search GitHub for repos: 'Shai-Hulud: Here We Go Again'${R}"
                Write-Host "  ${WH}  Search commits: 'OhNoWhatsGoingOnWithGitHub'${R}"
                Write-Host "  ${WH}  Review npm audit log for unexpected publishes${R}"
                Read-Host "  Press Enter"
            }
            'E' {
                $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
                $out = "supply-chain-report-$ts.json"
                [PSCustomObject]@{
                    generatedAt=(Get-Date -Format 'o'); psVersion="$($PSVersionTable.PSVersion)"
                    dotnetVersion="$([System.Environment]::Version)"; iocCount=($global:Flagged.Count)
                    criticalWormWarning='ISOLATE MACHINE BEFORE REVOKING TOKENS'
                    c2Domains=@('sfrclak[.]com','142.11.206.73','45[.]32[.]150[.]251','217[.]69[.]3[.]152','checkmarx[.]zone','83[.]142[.]209[.]194','git-tanstack[.]com','getsession.org')
                    packages=($global:Flagged | ForEach-Object { [PSCustomObject]@{pkg=($_.pkg);ver=($_.ver);severity=(Get-InferredSev $_);category=($_.category);safe=($_.safe);c2=($_.c2);remediation=($_.remediation)} })
                } | ConvertTo-Json -Depth 10 | Set-Content $out -Encoding utf8
                Write-Host "  ${GR}  Saved: $out${R}"; Read-Host "  Press Enter"
            }
            'C' {
                Show-Banner; Write-Section "CREDENTIAL ROTATION"
                Write-Host "  ${CR}${BD}!! ISOLATE MACHINE BEFORE REVOKING TOKENS !!${R}`n"
                Write-Host "  ${WH}  npm tokens     npm token revoke${R}"
                Write-Host "  ${WH}  GitHub PATs    github.com/settings/tokens${R}"
                Write-Host "  ${WH}  OIDC trusts    Review all workflow permissions${R}"
                Write-Host "  ${WH}  SSH keys       Remove from all authorized_keys${R}"
                Write-Host "  ${WH}  AWS/GCP/Azure  Rotate all cloud creds${R}"
                Write-Host "  ${WH}  k8s tokens     kubectl delete secret${R}"
                Write-Host "  ${WH}  Vault tokens   Revoke and reissue${R}"
                Write-Host "  ${WH}  CI/CD secrets  Rotate in Actions/GitLab/Jenkins${R}"
                Write-Host "  ${WH}  .env files     Rotate every value${R}"
                Write-Host "  ${WH}  Crypto wallets Transfer to new wallet immediately${R}`n"
                Write-Host "  ${YL}  Audit windows:${R}"
                Write-Host "  ${YL}  Mini Shai-Hulud Wave 3: May 11 19:20-19:26 UTC${R}"
                Write-Host "  ${YL}  Mini Shai-Hulud Wave 1: April 29 09:55-14:00 UTC${R}"
                Write-Host "  ${YL}  Bitwarden:              April 22 21:57-23:30 UTC${R}"
                Write-Host "  ${YL}  Axios RAT:              March 31 00:21-03:15 UTC${R}"
                Read-Host "  Press Enter"
            }
            'F' {
                Show-Banner; Write-Section "FIREWALL BLOCK LIST"
                Write-Host "  ${CR}${BD}Block ALL at network egress:${R}`n"
                Write-Host "  ${CR}  sfrclak.com           Axios RAT C2 (UNC1069/DPRK)${R}"
                Write-Host "  ${CR}  142.11.206.73         Axios RAT C2 IP${R}"
                Write-Host "  ${CR}  45.32.150.251         GlassWorm C2${R}"
                Write-Host "  ${CR}  217.69.3.152          GlassWorm C2${R}"
                Write-Host "  ${CR}  checkmarx.zone        TeamPCP KICS/Trivy C2${R}"
                Write-Host "  ${CR}  83.142.209.203        TeamPCP/LiteLLM C2${R}"
                Write-Host "  ${CR}  83.142.209.194        Mini Shai-Hulud/Mistral C2${R}"
                Write-Host "  ${CR}  git-tanstack.com      Mini Shai-Hulud C2 typosquat${R}"
                Write-Host "  ${CR}  *.getsession.org      Mini Shai-Hulud Session C2${R}"
                Write-Host "  ${CR}  models.litellm.cloud  TeamPCP LiteLLM C2${R}"
                Write-Host "`n  ${YL}  Windows Firewall (run as Admin):${R}"
                Write-Host "  ${WH}  netsh advfirewall firewall add rule name=`"Block-MiniShaiHulud`" dir=out action=block remoteip=83.142.209.194${R}"
                Write-Host "  ${WH}  netsh advfirewall firewall add rule name=`"Block-AxiosRAT`" dir=out action=block remoteip=142.11.206.73${R}"
                Write-Host "  ${WH}  netsh advfirewall firewall add rule name=`"Block-GlassWorm`" dir=out action=block remoteip=45.32.150.251,217.69.3.152${R}"
                Write-Host "  ${WH}  Add-Content C:\Windows\System32\drivers\etc\hosts `"0.0.0.0 git-tanstack.com`"${R}"
                Read-Host "  Press Enter"
            }
            '0' { return }
            default {
                if ($ch -match '^\d+$') {
                    $idx = [int]$ch - 1
                    if ($idx -ge 0 -and $idx -lt $global:Flagged.Count) {
                        $t = $global:Flagged[$idx]
                        Show-Banner; Write-Section "REMEDIATE: $($t.pkg)@$($t.ver)"
                        Write-Host "  $(Get-SevIcon (Get-InferredSev $t)) $(Get-SevColor (Get-InferredSev $t))$($t.pkg)@$($t.ver)${R}  ${DM}[$($t.category)]${R}"
                        Write-Host "  ${DM}  $($t.desc)${R}"
                        if ($t.c2) { Write-Host "  ${CR}  C2: $($t.c2)${R}" }
                        if ($t.remediation) { Write-Host "`n  ${CY}  FIX: $($t.remediation)${R}" }
                        Write-Host ""
                        $action = Read-Host "  (p)in safe  (r)emove  (b)ack"
                        switch ($action) {
                            'p' { if ($t.safe -and (Confirm-Action "npm install $($t.pkg)@$($t.safe) --save-exact")) { Write-Host (Invoke-Npm 'install',"$($t.pkg)@$($t.safe)",'--save-exact') } }
                            'r' { if ((Confirm-Action "Remove $($t.pkg)?") -and (Confirm-Action "FINAL CONFIRM")) { Write-Host (Invoke-Npm 'uninstall',$t.pkg) } }
                        }
                        Read-Host "  Press Enter"
                    }
                }
            }
        }
    }
}

function Load-ExternalJson {
    Show-Banner; Write-Section "LOAD EXTERNAL JSON IOC UPDATES"
    $path = Read-Host "  Path to JSON file"
    if (-not $path -or -not (Test-Path $path)) { Write-Host "  ${CR}  File not found.${R}"; Read-Host "  Press Enter"; return }
    try {
        $u = Get-Content $path -Raw | ConvertFrom-Json; $added=0; $skipped=0
        foreach ($item in $u) {
            if (-not $item.pkg -or -not $item.ver) { $skipped++; continue }
            if ($global:Flagged | Where-Object { $_.pkg -eq $item.pkg -and $_.ver -eq $item.ver }) { $skipped++; continue }
            $global:Flagged += [PSCustomObject]@{
                pkg=($item.pkg.Trim());ver=($item.ver.Trim())
                severity=(if ($item.severity -in @('CRITICAL','HIGH','MEDIUM')) {$item.severity} else {'HIGH'})
                category=(if ($item.category) {$item.category} else {"External-$(Get-Date -Format 'yyyyMMdd')"})
                safe=(if ($item.safe) {$item.safe} else {$null})
                desc=(if ($item.desc) {$item.desc} else {"Loaded from $path"})
                remediation=(if ($item.remediation) {$item.remediation} else {'See vendor advisory.'})
                c2=(if ($item.c2) {$item.c2} else {'unknown'})
            }; $added++
        }
        if ($added -gt 0) { Save-Flagged $global:Flagged; Write-Host "  ${GR}  $added entries added.${R}" }
        else { Write-Host "  ${OR}  No new entries (skipped $skipped duplicates).${R}" }
    } catch { Write-Host "  ${CR}  JSON error: $($_.Exception.Message)${R}" }
    Read-Host "  Press Enter"
}

# ── Entry point ──────────────────────────────────────────────────────────────
Invoke-SafetyCheck

while ($true) {
    Show-Banner
    Write-Host "  ${CR}${BD}  !! ISOLATE BEFORE REVOKING TOKENS -- WORM TRIGGERS rm-rf !!${R}`n"
    Write-Host "  ${DM}┌────────────────────────────────────────────────────────────────┐${R}"
    Write-Host "  ${DM}│${R}                        ${CY}${BD}MAIN MENU${R}                                ${DM}│${R}"
    Write-Host "  ${DM}├────────────────────────────────────────────────────────────────┤${R}"
    Write-Host "  ${DM}│${R}  ${WH}1. View all flagged packages  (category filter)               ${DM}│${R}"
    Write-Host "  ${DM}│${R}  ${WH}2. Add new flagged package manually                           ${DM}│${R}"
    Write-Host "  ${DM}│${R}  ${YL}3. Scan: direct + transitive + worm file check               ${DM}│${R}"
    Write-Host "  ${DM}│${R}  ${WH}4. Check outdated packages                                   ${DM}│${R}"
    Write-Host "  ${DM}│${R}  ${WH}5. Lockfile + install script + phantom dir inspect           ${DM}│${R}"
    Write-Host "  ${DM}│${R}  ${CR}${BD}6. REMEDIATION MENU  (per-pkg + isolation steps + bulk)     ${R}${DM}│${R}"
    Write-Host "  ${DM}│${R}  ${YL}7. Full combined scan                                        ${DM}│${R}"
    Write-Host "  ${DM}│${R}  ${CY}8. Load external JSON IOC updates                            ${DM}│${R}"
    Write-Host "  ${DM}│${R}  ${CR}9. Firewall list + credential checklist                      ${DM}│${R}"
    Write-Host "  ${DM}│${R}  ${DM}0. Exit                                                       ${DM}│${R}"
    Write-Host "  ${DM}└────────────────────────────────────────────────────────────────┘${R}"
    Write-Host "`n  ${DM}IOC DB: $($global:Flagged.Count) entries  |  $(Split-Path -Leaf (Get-Location))${R}`n"
    $menuChoice = Read-Host "  Enter number (0-9)"
    switch ($menuChoice) {
        '1' { Show-Flagged }
        '2' {
            Show-Banner; Write-Section "ADD NEW FLAGGED PACKAGE"
            $pkg=Read-Host "  Package name"; $ver=Read-Host "  Version"; $sev=Read-Host "  Severity [default:HIGH]"
            $desc=Read-Host "  Description"; $safe=Read-Host "  Safe version (Enter to skip)"; $rem=Read-Host "  Remediation"
            if (-not $pkg -or -not $ver) { Write-Host "  ${CR}  Required.${R}"; Read-Host "  Press Enter"; break }
            if ($sev -notin @('CRITICAL','HIGH','MEDIUM')) { $sev='HIGH' }
            if (-not ($global:Flagged | Where-Object { $_.pkg -eq $pkg.Trim() -and $_.ver -eq $ver.Trim() })) {
                $global:Flagged += [PSCustomObject]@{pkg=($pkg.Trim());ver=($ver.Trim());severity=($sev.ToUpper());category="User-Added-$(Get-Date -Format 'yyyyMMdd')";safe=(if($safe){$safe.Trim()}else{$null});desc=(if($desc){$desc.Trim()}else{'User-added'});remediation=(if($rem){$rem.Trim()}else{'See advisory.'});c2='unknown'}
                Save-Flagged $global:Flagged; Write-Host "  ${GR}  Saved.${R}"
            } else { Write-Host "  ${OR}  Already exists.${R}" }
            Read-Host "  Press Enter"
        }
        '3' { Invoke-Scan }
        '4' { Show-Banner; Write-Section "OUTDATED PACKAGES"; $o=Invoke-Npm 'outdated'; if(-not $o.Trim()){Write-Host "  ${GR}  OK${R}"}else{Write-Host "$OR$o$R"}; Read-Host "  Press Enter" }
        '5' {
            Show-Banner; Write-Section "LOCKFILE + INSTALL SCRIPT + PHANTOM DIR"
            if (Test-Path 'package-lock.json') {
                $lock=Get-Content 'package-lock.json' -Raw
                @('postinstall','preinstall','plain-crypto-js','sfrclak','1\.14\.1','0\.30\.4','79ac49ee','setup\.mjs','router_init','tanstack_runner') | ForEach-Object {
                    if ($lock -match $_) { Write-Host "  ${CR}  !! Pattern in lockfile: $_${R}" }
                }
            } else { Write-Host "  ${OR}  WARN: No package-lock.json${R}" }
            foreach ($ph in @('plain-crypto-js','@cap-js/sqlite','@cap-js/postgres','@bitwarden/cli')) {
                if (Test-Path (Join-Path 'node_modules' $ph)) { Write-Host "  ${CR}${BD}  !! IN NODE_MODULES: $ph${R}" }
            }
            # Check for Mini Shai-Hulud worm files
            foreach ($f in @('setup.mjs','router_init.js','router_runtime.js','tanstack_runner.js')) {
                Get-ChildItem -Recurse -Filter $f -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  ${CR}${BD}  !! WORM FILE: $($_.FullName)${R}" }
            }
            Read-Host "  Press Enter"
        }
        '6' { Invoke-RemediationMenu }
        '7' {
            Show-Banner; Write-Section "FULL COMBINED SCAN"
            $found = Invoke-Scan -silent $true
            Write-Host ""; $o=Invoke-Npm 'outdated'; if($o.Trim()){Write-Host "${OR}Outdated:$o${R}"}
            Write-Host "  ${CY}${BD}SCAN COMPLETE -- IOC hits: $($found.Count)  |  DB: $($global:Flagged.Count)${R}"
            Read-Host "  Press Enter"
        }
        '8' { Load-ExternalJson }
        '9' {
            Show-Banner; Write-Section "C2 DOMAINS + FIREWALL"
            Write-Host "  ${CR}  sfrclak.com / 142.11.206.73     Axios RAT (DPRK)${R}"
            Write-Host "  ${CR}  45.32.150.251 / 217.69.3.152    GlassWorm${R}"
            Write-Host "  ${CR}  checkmarx.zone / 83.142.209.203 TeamPCP${R}"
            Write-Host "  ${CR}  83.142.209.194                  Mini Shai-Hulud / Mistral${R}"
            Write-Host "  ${CR}  git-tanstack.com                Mini Shai-Hulud C2 typosquat${R}"
            Write-Host "  ${CR}  *.getsession.org                Mini Shai-Hulud Session C2${R}"
            Write-Host "  ${CR}  models.litellm.cloud            LiteLLM C2${R}"
            Read-Host "  Press Enter"
        }
        '0' { Show-Banner; Write-Host "  ${GR}${BD}  Scanner closed.${R}`n  ${DM}  IOC list: $FlaggedFile${R}"; exit }
        default { Write-Host "  ${CR}  Invalid - enter 0-9${R}"; Start-Sleep 1 }
    }
}


# SIG # Begin signature block
# MIIJIgYJKoZIhvcNAQcCoIIJEzCCCQ8CAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCAo6p7z0W/tFMsn
# XWZK+lya1aDrfZMuV5onsGFx5HtKsKCCBWgwggVkMIIDTKADAgECAhBEeDXFXkLZ
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
# IgQgj9UNe5/cfqjtQ4hETHR3WnVMGcCwe0Q0DBF9ACwIBqkwDQYJKoZIhvcNAQEB
# BQAEggIAsLKbTzAIUYE2J3Ci5kUdAKDWVxMcaYwCJvaVxCIInwGDHVVrv8++Sz16
# KvI69j+mrNMhErMqejdGXflfwWvh18t8Zi+dT5hrXrAUmKQjS7pJoEQg3Y6pniWD
# JXuoxsMSM/OUhax8+b/uGFuPXIPbJKZ8SEzKor3jkFOS993bfRaxDb4d0+iWA19I
# 4CwDQmZjzBT1bbr9vAm1JGkyn80kjH7bumn8pyPezEK5ISPyK4QZaPLel6CI8NOX
# sV7aMKUXhhf/1UKLg6fu85WJJe9hltVR3exEVpkRuqdJ7M6e3+rFk+Ro3B1MuzjC
# 0P6Pu6U9T6zTJQmYK/5wnJj9o6oCRw+cZxCaoe1XXO1ph2MX6q5hBxJokj3ZjzcY
# Qw6f2w28ASIVusdNeZKKeSKzporqDhtb9Ri7Xxu7Th6GIIWAUqkn/ZdDyl8RDlYp
# M3KrqmE41+WfFK9dzpyG8CesJspWTbduZUns3waM8yFd56AkEGW5PlSP1p5O88vk
# 3IL72FCHoiMe9s6w/jv1kkwKapEzTZ+aK4kYL1u1vGc/Yb/R204+Qd7KORjvSM3J
# kPcU0KsTGQtbEaL/n7y77Va01DF0eqT9GJ5dM+Fl79RWZP/A5atx2h4cfx0Fb7PA
# icEvb4bHtdzS2LfRXHBXppOlW07R4yot0102Vl+rMgVx+z/hoE8=
# SIG # End signature block
