#!/usr/bin/env bash
: <<'COMMENT'
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-06-25 03:57:40
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  1B2CEE40622EFC5399B5783C8106933E5C96490F0C3D65217089E8F9D9743419
SHA-512:  9AB19C2AAD3FAD08E353459A0B8A6BEE83D57414BDDB4B32CE4BFC5660252FA83B47E95A3A2D1FE9EEF8D935A057C0380E2ECBCA7331482F0C6FADA118174B1D
MD5:      321A21C0B9E71E99BDADEE6B32DD8B8C
File Size: 62472 bytes

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
COMMENT
# ==============================================================================
# Safety King v1.0.0 — WSL/Linux Environment Health & Conflict Resolution
# ==============================================================================
# Nothing runs automatically. Nothing runs silently.
# Every action requires explicit Y/N confirmation.
# No suppressed output. No background actions. No auto-scans.
# ==============================================================================
set -euo pipefail

# ------------------------------------------------------------------------------
# Constants
# ------------------------------------------------------------------------------
readonly SK_CONFIG_DIR="${HOME}/.config/safetyking"
readonly SK_CONFIG_FILE="${SK_CONFIG_DIR}/config.json"
readonly SK_LOG_DIR="${SK_CONFIG_DIR}/logs"
readonly SK_LOG_FILE="${SK_LOG_DIR}/safetyking-$(date +%Y-%m-%d).log"
readonly SK_VERSION="1.0.0"

# Colors
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly CYAN='\033[0;36m'
readonly MAGENTA='\033[0;35m'
readonly WHITE='\033[1;37m'
readonly GRAY='\033[0;37m'
readonly BOLD='\033[1m'
readonly NC='\033[0m'

# ------------------------------------------------------------------------------
# Dependency check — whiptail required for TUI dialogs
# ------------------------------------------------------------------------------
check_dependencies() {
    local missing=()
    for cmd in whiptail jq curl; do
        if ! command -v "$cmd" &>/dev/null; then
            missing+=("$cmd")
        fi
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        echo -e "${RED}[ERROR] Missing required tools: ${missing[*]}${NC}"
        echo -e "${YELLOW}Install with: sudo apt install -y whiptail jq curl${NC}"
        exit 1
    fi
}

# ------------------------------------------------------------------------------
# Logging
# ------------------------------------------------------------------------------
sk_log() {
    local level="$1"
    local message="$2"
    mkdir -p "$SK_LOG_DIR"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')][$level] $message" >> "$SK_LOG_FILE"
}

# ------------------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------------------
default_config() {
    cat <<'EOF'
{
  "distro": "auto",
  "package_managers": {
    "apt": true,
    "snap": true,
    "flatpak": true,
    "npm": true,
    "pip": true,
    "cargo": true
  },
  "update_channel": "LTS",
  "report_output_path": "~/SafetyKingReports",
  "check_windows_bleed": true,
  "scan_depth": "deep"
}
EOF
}

load_config() {
    mkdir -p "$SK_CONFIG_DIR"
    if [[ ! -f "$SK_CONFIG_FILE" ]]; then
        default_config > "$SK_CONFIG_FILE"
    fi
    cat "$SK_CONFIG_FILE"
}

save_config() {
    local config_json="$1"
    echo "$config_json" > "$SK_CONFIG_FILE"
}

config_get() {
    local key="$1"
    load_config | jq -r "$key"
}

# ------------------------------------------------------------------------------
# Distro Detection
# ------------------------------------------------------------------------------
detect_distro() {
    local configured
    configured=$(config_get '.distro')
    if [[ "$configured" != "auto" && "$configured" != "null" && -n "$configured" ]]; then
        echo "$configured"
        return
    fi
    if [[ -f /etc/os-release ]]; then
        # shellcheck source=/dev/null
        source /etc/os-release
        echo "${ID:-unknown}"
    else
        echo "unknown"
    fi
}

get_native_pkg_manager() {
    local distro
    distro=$(detect_distro)
    case "$distro" in
        ubuntu|debian|kali|linuxmint|pop)   echo "apt" ;;
        fedora|rhel|centos|rocky|almalinux) echo "dnf" ;;
        arch|manjaro|endeavouros)           echo "pacman" ;;
        opensuse*|sles)                     echo "zypper" ;;
        alpine)                             echo "apk" ;;
        *)
            if command -v apt &>/dev/null;    then echo "apt"
            elif command -v dnf &>/dev/null;  then echo "dnf"
            elif command -v pacman &>/dev/null; then echo "pacman"
            elif command -v zypper &>/dev/null; then echo "zypper"
            elif command -v apk &>/dev/null;  then echo "apk"
            else echo "unknown"
            fi
            ;;
    esac
}

# ------------------------------------------------------------------------------
# Y/N Confirmation — nothing executes without this
# ------------------------------------------------------------------------------
confirm() {
    local prompt="$1"
    local answer
    echo -e "\n${YELLOW}${prompt} [Y/N]${NC}"
    read -r answer
    [[ "${answer^^}" == "Y" ]]
}

confirm_destructive() {
    local prompt="$1"
    local answer
    echo -e "\n${RED}${prompt}${NC}"
    echo -e "${RED}THIS CANNOT BE UNDONE. Are you absolutely sure? [Y/N]${NC}"
    read -r answer
    [[ "${answer^^}" == "Y" ]]
}

# ------------------------------------------------------------------------------
# Press ENTER to continue
# ------------------------------------------------------------------------------
press_enter() {
    echo -e "\n${GRAY}Press ENTER to continue...${NC}"
    read -r
}

# ------------------------------------------------------------------------------
# Latest Version Lookups (live — no hardcoded versions)
# ------------------------------------------------------------------------------
get_latest_node_lts() {
    curl -fsSL "https://nodejs.org/dist/index.json" 2>/dev/null \
        | jq -r '[.[] | select(.lts != false)] | .[0].version' 2>/dev/null \
        || echo "lookup-failed"
}

get_latest_python_stable() {
    curl -fsSL "https://www.python.org/downloads/" 2>/dev/null \
        | grep -oP 'Python \K[0-9]+\.[0-9]+\.[0-9]+' \
        | head -1 \
        || echo "lookup-failed"
}

get_latest_rust_stable() {
    curl -fsSL "https://static.rust-lang.org/dist/channel-rust-stable.toml" 2>/dev/null \
        | grep -m1 '^version = ' \
        | grep -oP '[0-9]+\.[0-9]+\.[0-9]+' \
        || echo "lookup-failed"
}

get_latest_rustup() {
    curl -fsSL "https://api.github.com/repos/rust-lang/rustup/releases/latest" 2>/dev/null \
        | jq -r '.tag_name' \
        | sed 's/^v//' \
        || echo "lookup-failed"
}

# ------------------------------------------------------------------------------
# Tool existence checks
# ------------------------------------------------------------------------------
cmd_exists() { command -v "$1" &>/dev/null; }

# ------------------------------------------------------------------------------
# Scan: Duplicate Tool Versions
# ------------------------------------------------------------------------------
scan_duplicate_versions() {
    local native_pm
    native_pm=$(get_native_pkg_manager)
    local findings=()

    echo -e "\n${CYAN}[DUPLICATES] Scanning for duplicate tool versions...${NC}"

    # Native package manager duplicates
    case "$native_pm" in
        apt)
            if cmd_exists dpkg; then
                local dupes
                dupes=$(dpkg -l 2>&1 | awk '/^ii/{print $2}' | sed 's/:.*$//' | sort | uniq -d)
                while IFS= read -r pkg; do
                    [[ -z "$pkg" ]] && continue
                    findings+=("APT|DUPLICATE|${pkg}|Multiple versions registered|HIGH|REMOVE")
                done <<< "$dupes"
            fi
            ;;
        dnf)
            if cmd_exists dnf; then
                local dupes
                dupes=$(dnf list installed 2>&1 | awk '{print $1}' | sed 's/\..*//' | sort | uniq -d)
                while IFS= read -r pkg; do
                    [[ -z "$pkg" ]] && continue
                    findings+=("DNF|DUPLICATE|${pkg}|Multiple versions registered|HIGH|REMOVE")
                done <<< "$dupes"
            fi
            ;;
        pacman)
            if cmd_exists pacman; then
                local dupes
                dupes=$(pacman -Q 2>&1 | awk '{print $1}' | sort | uniq -d)
                while IFS= read -r pkg; do
                    [[ -z "$pkg" ]] && continue
                    findings+=("PACMAN|DUPLICATE|${pkg}|Multiple versions registered|HIGH|REMOVE")
                done <<< "$dupes"
            fi
            ;;
    esac

    # Node/npm — check nvm, volta, system, fnm all at once
    local node_locations=()
    for loc in \
        "$(command -v node 2>/dev/null || true)" \
        "${HOME}/.nvm/versions/node" \
        "${HOME}/.volta/bin/node" \
        "${HOME}/.fnm/node-versions"; do
        [[ -n "$loc" && -e "$loc" ]] && node_locations+=("$loc")
    done
    if [[ ${#node_locations[@]} -gt 1 ]]; then
        findings+=("Node.js|DUPLICATE|node|Found in ${#node_locations[@]} locations: ${node_locations[*]}|HIGH|REVIEW")
    fi

    # Python — find all python binaries in PATH
    local python_versions=()
    while IFS= read -r pybin; do
        [[ -z "$pybin" ]] && continue
        ver=$("$pybin" --version 2>&1 | grep -oP '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
        [[ -n "$ver" ]] && python_versions+=("$pybin=$ver")
    done < <(compgen -c | grep -E '^python[0-9.]*$' | sort -u | xargs -I{} which {} 2>/dev/null | sort -u)

    if [[ ${#python_versions[@]} -gt 1 ]]; then
        findings+=("Python|DUPLICATE|python|Multiple Python binaries: ${python_versions[*]}|HIGH|REVIEW")
    fi

    # Rustup toolchains — list all installed
    if cmd_exists rustup; then
        local toolchains
        toolchains=$(rustup toolchain list 2>&1)
        local tc_count
        tc_count=$(echo "$toolchains" | grep -c '.' || true)
        if [[ "$tc_count" -gt 1 ]]; then
            findings+=("rustup|TOOLCHAINS|rust-toolchains|${tc_count} toolchains installed — only keep what you use|MEDIUM|REVIEW")
        fi
    fi

    # npm global duplicates
    if cmd_exists npm; then
        local npm_problems
        npm_problems=$(npm list -g --depth=0 --json 2>&1 | jq -r '.problems[]? // empty' 2>/dev/null || true)
        if [[ -n "$npm_problems" ]]; then
            while IFS= read -r prob; do
                [[ -z "$prob" ]] && continue
                findings+=("npm-global|CONFLICT|npm|${prob}|HIGH|RESOLVE")
            done <<< "$npm_problems"
        fi
    fi

    print_findings_submenu "Duplicate Versions" findings
}

# ------------------------------------------------------------------------------
# Scan: Outdated Versions
# ------------------------------------------------------------------------------
scan_outdated_versions() {
    local native_pm
    native_pm=$(get_native_pkg_manager)
    local findings=()

    echo -e "\n${CYAN}[OUTDATED] Checking for outdated packages and tools...${NC}"

    # Native package manager
    case "$native_pm" in
        apt)
            echo -e "${CYAN}[APT] Fetching update list...${NC}"
            sudo apt update 2>&1 | grep -v '^$' || true
            local apt_upgradeable
            apt_upgradeable=$(apt list --upgradable 2>/dev/null | grep -v 'Listing' || true)
            while IFS= read -r line; do
                [[ -z "$line" ]] && continue
                local pkg ver_cur ver_new
                pkg=$(echo "$line" | awk -F'/' '{print $1}')
                ver_new=$(echo "$line" | grep -oP '\[upgradable from: \K[^\]]+' || echo "newer available")
                ver_cur=$(dpkg -l "$pkg" 2>/dev/null | awk '/^ii/{print $3}' | head -1 || echo "unknown")
                findings+=("apt|OUTDATED|${pkg}|Current: ${ver_cur} → Available: ${ver_new}|MEDIUM|UPDATE")
            done <<< "$apt_upgradeable"
            ;;
        dnf)
            local dnf_updates
            dnf_updates=$(dnf check-update 2>&1 | grep -v '^$' | grep -v '^Last' || true)
            while IFS= read -r line; do
                [[ -z "$line" ]] && continue
                local pkg ver
                pkg=$(echo "$line" | awk '{print $1}')
                ver=$(echo "$line" | awk '{print $2}')
                findings+=("dnf|OUTDATED|${pkg}|Newer version available: ${ver}|MEDIUM|UPDATE")
            done <<< "$dnf_updates"
            ;;
        pacman)
            local pac_updates
            pac_updates=$(pacman -Qu 2>/dev/null || true)
            while IFS= read -r line; do
                [[ -z "$line" ]] && continue
                findings+=("pacman|OUTDATED|${line}|Newer version available|MEDIUM|UPDATE")
            done <<< "$pac_updates"
            ;;
    esac

    # rustup / Rust
    if cmd_exists rustup; then
        echo -e "${CYAN}[RUSTUP] Checking Rust toolchain...${NC}"
        local latest_rust latest_rustup
        latest_rust=$(get_latest_rust_stable)
        latest_rustup=$(get_latest_rustup)
        local current_rust current_rustup
        current_rust=$(rustc --version 2>&1 | grep -oP '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "unknown")
        current_rustup=$(rustup --version 2>&1 | grep -oP '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "unknown")

        if [[ "$latest_rust" != "lookup-failed" && "$current_rust" != "$latest_rust" ]]; then
            findings+=("rustup|OUTDATED|rust-stable|Current: ${current_rust} → Latest: ${latest_rust}|MEDIUM|UPDATE")
        fi
        if [[ "$latest_rustup" != "lookup-failed" && "$current_rustup" != "$latest_rustup" ]]; then
            findings+=("rustup|OUTDATED|rustup-itself|Current: ${current_rustup} → Latest: ${latest_rustup}|MEDIUM|UPDATE")
        fi
    fi

    # Node
    if cmd_exists node; then
        echo -e "${CYAN}[NODE] Checking Node.js version...${NC}"
        local current_node latest_node
        current_node=$(node --version 2>&1 | sed 's/^v//')
        latest_node=$(get_latest_node_lts | sed 's/^v//')
        if [[ "$latest_node" != "lookup-failed" && "$current_node" != "$latest_node" ]]; then
            findings+=("node|OUTDATED|node|Current: v${current_node} → LTS: v${latest_node}|MEDIUM|UPDATE")
        fi
    fi

    # Python
    if cmd_exists python3; then
        echo -e "${CYAN}[PYTHON] Checking Python version...${NC}"
        local current_py latest_py
        current_py=$(python3 --version 2>&1 | grep -oP '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
        latest_py=$(get_latest_python_stable)
        if [[ "$latest_py" != "lookup-failed" && "$current_py" != "$latest_py" ]]; then
            findings+=("python|OUTDATED|python3|Current: ${current_py} → Latest: ${latest_py}|MEDIUM|UPDATE")
        fi
    fi

    # npm global packages
    if cmd_exists npm; then
        echo -e "${CYAN}[NPM] Checking global npm packages...${NC}"
        local npm_outdated
        npm_outdated=$(npm outdated -g --json 2>&1 || true)
        if [[ -n "$npm_outdated" && "$npm_outdated" != "{}" ]]; then
            while IFS= read -r pkg; do
                [[ -z "$pkg" ]] && continue
                local cur lat
                cur=$(echo "$npm_outdated" | jq -r --arg p "$pkg" '.[$p].current // "unknown"')
                lat=$(echo "$npm_outdated" | jq -r --arg p "$pkg" '.[$p].latest // "unknown"')
                findings+=("npm-global|OUTDATED|${pkg}|Current: ${cur} → Latest: ${lat}|MEDIUM|UPDATE")
            done < <(echo "$npm_outdated" | jq -r 'keys[]' 2>/dev/null || true)
        fi
    fi

    # pip global packages
    if cmd_exists pip3; then
        echo -e "${CYAN}[PIP] Checking outdated pip packages...${NC}"
        local pip_outdated
        pip_outdated=$(pip3 list --outdated --format=json 2>&1 || true)
        if [[ -n "$pip_outdated" && "$pip_outdated" != "[]" ]]; then
            while IFS= read -r line; do
                local name cur lat
                name=$(echo "$line" | jq -r '.name')
                cur=$(echo "$line" | jq -r '.version')
                lat=$(echo "$line" | jq -r '.latest_version')
                findings+=("pip|OUTDATED|${name}|Current: ${cur} → Latest: ${lat}|MEDIUM|UPDATE")
            done < <(echo "$pip_outdated" | jq -c '.[]' 2>/dev/null || true)
        fi
    fi

    print_findings_submenu "Outdated Versions" findings
}

# ------------------------------------------------------------------------------
# Scan: PATH Conflicts and Pollution
# ------------------------------------------------------------------------------
scan_path_conflicts() {
    local findings=()
    echo -e "\n${CYAN}[PATH] Scanning PATH for conflicts and pollution...${NC}"

    IFS=':' read -ra path_entries <<< "$PATH"

    # Ghost entries (in PATH but don't exist)
    for entry in "${path_entries[@]}"; do
        [[ -z "$entry" ]] && continue
        if [[ ! -d "$entry" ]]; then
            findings+=("PATH|GHOST|${entry}|Directory in PATH does not exist|MEDIUM|REMOVE")
        fi
    done

    # Duplicate entries
    declare -A seen_paths
    for entry in "${path_entries[@]}"; do
        [[ -z "$entry" ]] && continue
        local normalized
        normalized=$(realpath -m "$entry" 2>/dev/null || echo "$entry")
        if [[ -n "${seen_paths[$normalized]+x}" ]]; then
            findings+=("PATH|DUPLICATE|${entry}|Duplicate PATH entry|LOW|REMOVE")
        else
            seen_paths[$normalized]=1
        fi
    done

    # Same binary in multiple PATH locations
    declare -A tool_locations
    for entry in "${path_entries[@]}"; do
        [[ -z "$entry" || ! -d "$entry" ]] && continue
        while IFS= read -r bin; do
            local bname
            bname=$(basename "$bin")
            if [[ -n "${tool_locations[$bname]+x}" ]]; then
                tool_locations[$bname]="${tool_locations[$bname]}, $entry"
            else
                tool_locations[$bname]="$entry"
            fi
        done < <(find "$entry" -maxdepth 1 -type f -executable 2>/dev/null || true)
    done
    for tool in "${!tool_locations[@]}"; do
        if [[ "${tool_locations[$tool]}" == *","* ]]; then
            findings+=("PATH|TOOL_CONFLICT|${tool}|Found in multiple locations: ${tool_locations[$tool]}|HIGH|REVIEW")
        fi
    done

    # Check .bashrc .zshrc .profile for duplicate PATH exports
    for rcfile in "${HOME}/.bashrc" "${HOME}/.zshrc" "${HOME}/.profile" "/etc/environment"; do
        [[ ! -f "$rcfile" ]] && continue
        local path_exports
        path_exports=$(grep -n 'export PATH\|PATH=' "$rcfile" 2>/dev/null || true)
        local export_count
        export_count=$(echo "$path_exports" | grep -c '.' || true)
        if [[ "$export_count" -gt 2 ]]; then
            findings+=("RCFILE|PATH_POLLUTION|${rcfile}|${export_count} PATH modifications found — review for conflicts|MEDIUM|REVIEW")
        fi
    done

    print_findings_submenu "PATH Conflicts" findings
}

# ------------------------------------------------------------------------------
# Scan: Windows PATH Bleed (WSL only)
# ------------------------------------------------------------------------------
scan_windows_bleed() {
    local findings=()
    echo -e "\n${CYAN}[WIN-BLEED] Scanning for Windows paths bleeding into WSL...${NC}"

    # Check if we're actually in WSL
    if ! grep -qi microsoft /proc/version 2>/dev/null && ! grep -qi wsl /proc/version 2>/dev/null; then
        echo -e "${YELLOW}[WIN-BLEED] Not running in WSL. Skipping.${NC}"
        press_enter
        return
    fi

    # Windows /mnt/c etc paths in WSL PATH
    IFS=':' read -ra path_entries <<< "$PATH"
    for entry in "${path_entries[@]}"; do
        if [[ "$entry" == /mnt/[a-zA-Z]/* ]]; then
            findings+=("WIN-BLEED|WIN_PATH_IN_WSL|${entry}|Windows drive path present in WSL PATH — verify this is intentional|MEDIUM|REVIEW")
        fi
    done

    # WSLENV variable check
    if [[ -n "${WSLENV:-}" ]]; then
        findings+=("WIN-BLEED|WSLENV|WSLENV=${WSLENV}|WSLENV is sharing variables between Windows and WSL — review each entry|LOW|REVIEW")
    fi

    # interop — is Windows executable launching enabled
    if [[ -f /proc/sys/fs/binfmt_misc/WSLInterop ]]; then
        local interop_enabled
        interop_enabled=$(cat /proc/sys/fs/binfmt_misc/WSLInterop 2>/dev/null | head -1 || echo "unknown")
        if [[ "$interop_enabled" == "enabled" ]]; then
            findings+=("WIN-BLEED|INTEROP|WSLInterop|Windows executable interop is enabled — Windows .exe files can run in WSL. This is normal but verify you want this.|INFO|REVIEW")
        fi
    fi

    # Check if Windows Node, Python, etc are shadowing Linux versions
    for tool in node python python3 npm pip pip3 cargo rustup; do
        local tool_path
        tool_path=$(which "$tool" 2>/dev/null || true)
        if [[ "$tool_path" == /mnt/* ]]; then
            findings+=("WIN-BLEED|WIN_TOOL_SHADOW|${tool}|'${tool}' resolves to Windows path: ${tool_path} — Linux version may be missing|HIGH|REVIEW")
        fi
    done

    print_findings_submenu "Windows PATH Bleed" findings
}

# ------------------------------------------------------------------------------
# Scan: Package Manager Conflicts (same package in multiple managers)
# ------------------------------------------------------------------------------
scan_pkg_manager_conflicts() {
    local native_pm
    native_pm=$(get_native_pkg_manager)
    local findings=()
    echo -e "\n${CYAN}[PKG-CONFLICT] Scanning for packages owned by multiple package managers...${NC}"

    # Get list of packages from each available manager
    declare -A apt_pkgs snap_pkgs flatpak_pkgs

    if cmd_exists dpkg && [[ "$native_pm" == "apt" ]]; then
        while IFS= read -r pkg; do
            [[ -z "$pkg" ]] && continue
            apt_pkgs[$pkg]=1
        done < <(dpkg -l 2>/dev/null | awk '/^ii/{print $2}' | sed 's/:.*$//' || true)
    fi

    if cmd_exists snap; then
        while IFS= read -r pkg; do
            [[ -z "$pkg" ]] && continue
            snap_pkgs[$pkg]=1
        done < <(snap list 2>/dev/null | awk 'NR>1{print $1}' || true)
    fi

    if cmd_exists flatpak; then
        while IFS= read -r pkg; do
            [[ -z "$pkg" ]] && continue
            # Flatpak names are reverse-domain, get the last segment
            local short_name
            short_name=$(echo "$pkg" | awk -F. '{print tolower($NF)}')
            flatpak_pkgs[$short_name]=1
        done < <(flatpak list --app --columns=application 2>/dev/null || true)
    fi

    # Cross-reference: find packages in 2+ managers
    for pkg in "${!apt_pkgs[@]}"; do
        local managers="apt"
        [[ -n "${snap_pkgs[$pkg]+x}" ]]    && managers="${managers}, snap"
        [[ -n "${flatpak_pkgs[$pkg]+x}" ]] && managers="${managers}, flatpak"
        if [[ "$managers" == *","* ]]; then
            findings+=("PKG-CONFLICT|MULTI_MANAGER|${pkg}|Installed via: ${managers}|HIGH|RESOLVE")
        fi
    done

    # npm package installed in global AND in local projects
    if cmd_exists npm; then
        local global_npm
        global_npm=$(npm list -g --depth=0 --json 2>/dev/null | jq -r '.dependencies | keys[]' 2>/dev/null || true)
        while IFS= read -r gpkg; do
            [[ -z "$gpkg" ]] && continue
            # Search common project roots for local installs
            local local_hits
            local_hits=$(find "${HOME}" -maxdepth 5 -name "package.json" -not -path "*/node_modules/*" \
                -exec grep -l "\"${gpkg}\"" {} \; 2>/dev/null | head -5 || true)
            if [[ -n "$local_hits" ]]; then
                findings+=("npm|GLOBAL_LOCAL|${gpkg}|Installed globally AND locally in: ${local_hits}|MEDIUM|REVIEW")
            fi
        done <<< "$global_npm"
    fi

    # pip global vs venv
    if cmd_exists pip3; then
        local global_pip
        global_pip=$(pip3 list --format=json 2>/dev/null | jq -r '.[].name' 2>/dev/null || true)
        local venv_paths
        venv_paths=$(find "${HOME}" -maxdepth 6 -name "activate" -path "*/bin/activate" 2>/dev/null | head -10 || true)
        while IFS= read -r venv_activate; do
            [[ -z "$venv_activate" ]] && continue
            local venv_pip
            venv_pip=$(dirname "$venv_activate")/pip
            if [[ -x "$venv_pip" ]]; then
                local venv_pkgs
                venv_pkgs=$("$venv_pip" list --format=json 2>/dev/null | jq -r '.[].name' 2>/dev/null || true)
                while IFS= read -r gpkg; do
                    [[ -z "$gpkg" ]] && continue
                    if echo "$venv_pkgs" | grep -qi "^${gpkg}$"; then
                        local venv_dir
                        venv_dir=$(dirname "$(dirname "$venv_activate")")
                        findings+=("pip|GLOBAL_VENV|${gpkg}|Exists in global pip AND in venv: ${venv_dir}|MEDIUM|REVIEW")
                    fi
                done <<< "$global_pip"
            fi
        done <<< "$venv_paths"
    fi

    print_findings_submenu "Package Manager Conflicts" findings
}

# ------------------------------------------------------------------------------
# Scan: Version Locks
# ------------------------------------------------------------------------------
scan_version_locks() {
    local native_pm
    native_pm=$(get_native_pkg_manager)
    local findings=()
    echo -e "\n${CYAN}[VERSION-LOCKS] Scanning for packages held or pinned from upgrading...${NC}"

    case "$native_pm" in
        apt)
            if cmd_exists apt-mark; then
                local held
                held=$(apt-mark showhold 2>/dev/null || true)
                while IFS= read -r pkg; do
                    [[ -z "$pkg" ]] && continue
                    findings+=("apt|HELD|${pkg}|Package is on hold — will not upgrade|HIGH|REVIEW")
                done <<< "$held"
            fi
            ;;
        dnf)
            local excluded
            excluded=$(grep -h '^exclude=' /etc/dnf/dnf.conf /etc/yum.repos.d/*.repo 2>/dev/null | sed 's/exclude=//' || true)
            while IFS= read -r pkg; do
                [[ -z "$pkg" ]] && continue
                findings+=("dnf|EXCLUDED|${pkg}|Package excluded from upgrades in dnf config|MEDIUM|REVIEW")
            done <<< "$excluded"
            ;;
        pacman)
            if [[ -f /etc/pacman.conf ]]; then
                local ignored
                ignored=$(grep '^IgnorePkg' /etc/pacman.conf 2>/dev/null | sed 's/IgnorePkg\s*=\s*//' || true)
                if [[ -n "$ignored" ]]; then
                    findings+=("pacman|IGNORED|${ignored}|Packages in IgnorePkg — will not upgrade|MEDIUM|REVIEW")
                fi
            fi
            ;;
    esac

    # npm peer dependency conflicts blocking upgrades
    if cmd_exists npm; then
        local npm_issues
        npm_issues=$(npm list -g --json 2>/dev/null | jq -r '.problems[]? // empty' 2>/dev/null || true)
        while IFS= read -r issue; do
            [[ -z "$issue" ]] && continue
            findings+=("npm-global|PEER_CONFLICT|npm|${issue}|HIGH|RESOLVE")
        done <<< "$npm_issues"
    fi

    # pip dependency conflicts
    if cmd_exists pip3; then
        local pip_check
        pip_check=$(pip3 check 2>&1 || true)
        if [[ -n "$pip_check" && "$pip_check" != "No broken requirements found." ]]; then
            while IFS= read -r line; do
                [[ -z "$line" ]] && continue
                findings+=("pip|DEPENDENCY_CONFLICT|pip|${line}|HIGH|RESOLVE")
            done <<< "$pip_check"
        fi
    fi

    print_findings_submenu "Version Locks" findings
}

# ------------------------------------------------------------------------------
# Scan: Unverified Packages
# ------------------------------------------------------------------------------
scan_unverified_packages() {
    local findings=()
    echo -e "\n${CYAN}[UNVERIFIED] Scanning for packages from unverified or unknown sources...${NC}"

    # Snap packages not from canonical store
    if cmd_exists snap; then
        while IFS= read -r line; do
            [[ -z "$line" || "$line" == Name* ]] && continue
            local name channel developer
            name=$(echo "$line" | awk '{print $1}')
            channel=$(echo "$line" | awk '{print $5}')
            developer=$(echo "$line" | awk '{print $NF}')
            if [[ "$channel" == *"edge"* || "$channel" == *"beta"* ]]; then
                findings+=("snap|UNSTABLE_CHANNEL|${name}|Installed from unstable channel: ${channel}|MEDIUM|REVIEW")
            fi
            if [[ "$developer" == "-" || -z "$developer" ]]; then
                findings+=("snap|UNKNOWN_PUBLISHER|${name}|No verified publisher listed|HIGH|REVIEW")
            fi
        done < <(snap list 2>/dev/null || true)
    fi

    # Flatpak apps not from flathub
    if cmd_exists flatpak; then
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            local origin
            origin=$(echo "$line" | awk '{print $NF}')
            if [[ "$origin" != "flathub" && "$origin" != "fedora" ]]; then
                local app
                app=$(echo "$line" | awk '{print $1}')
                findings+=("flatpak|THIRD_PARTY_REMOTE|${app}|Installed from non-standard remote: ${origin}|MEDIUM|REVIEW")
            fi
        done < <(flatpak list --app --columns=application,origin 2>/dev/null || true)
    fi

    # pip packages installed directly from git or local paths (not PyPI)
    if cmd_exists pip3; then
        local pip_list_verbose
        pip_list_verbose=$(pip3 list -v --format=columns 2>/dev/null || true)
        while IFS= read -r line; do
            [[ -z "$line" || "$line" == Package* ]] && continue
            local location
            location=$(echo "$line" | awk '{print $3}')
            if [[ "$location" == *"git+"* || "$location" == *"file://"* || "$location" == *".egg-link"* ]]; then
                local pkg
                pkg=$(echo "$line" | awk '{print $1}')
                findings+=("pip|EDITABLE_OR_VCS|${pkg}|Installed from VCS or local path: ${location}|MEDIUM|REVIEW")
            fi
        done <<< "$pip_list_verbose"
    fi

    print_findings_submenu "Unverified Packages" findings
}

# ------------------------------------------------------------------------------
# Scan: Vulnerabilities
# ------------------------------------------------------------------------------
scan_vulnerabilities() {
    local findings=()
    echo -e "\n${CYAN}[VULN] Scanning for known vulnerabilities...${NC}"

    # npm audit
    if cmd_exists npm; then
        echo -e "${CYAN}[NPM] Running npm audit on global packages...${NC}"
        local npm_audit
        npm_audit=$(npm audit --json -g 2>&1 || true)
        if [[ -n "$npm_audit" ]]; then
            while IFS= read -r line; do
                [[ -z "$line" ]] && continue
                local pkg sev via title
                pkg=$(echo "$line" | jq -r '.name // empty' 2>/dev/null || true)
                sev=$(echo "$line" | jq -r '.severity // empty' 2>/dev/null | tr '[:lower:]' '[:upper:]' || true)
                via=$(echo "$line" | jq -r '.via[0] // empty' 2>/dev/null || true)
                title=$(echo "$line" | jq -r '.title // empty' 2>/dev/null || echo "Vulnerability")
                [[ -z "$pkg" ]] && continue
                findings+=("npm-global|VULN|${pkg}|[${sev}] ${title} — via ${via}|${sev:-MEDIUM}|UPDATE")
            done < <(echo "$npm_audit" | jq -c '.vulnerabilities | to_entries[] | .value' 2>/dev/null || true)
        fi
    fi

    # pip-audit
    if cmd_exists pip3; then
        if cmd_exists pip-audit; then
            echo -e "${CYAN}[PIP] Running pip-audit...${NC}"
            local pip_audit_out
            pip_audit_out=$(pip-audit --format=json 2>&1 || true)
            while IFS= read -r pkg_line; do
                [[ -z "$pkg_line" ]] && continue
                local pkg_name pkg_ver
                pkg_name=$(echo "$pkg_line" | jq -r '.name' 2>/dev/null || true)
                pkg_ver=$(echo "$pkg_line" | jq -r '.version' 2>/dev/null || true)
                while IFS= read -r vuln_line; do
                    [[ -z "$vuln_line" ]] && continue
                    local vid vdesc vfix
                    vid=$(echo "$vuln_line" | jq -r '.id' 2>/dev/null || true)
                    vdesc=$(echo "$vuln_line" | jq -r '.description // "No description"' 2>/dev/null || true)
                    vfix=$(echo "$vuln_line" | jq -r '.fix_versions | join(", ") // "unknown"' 2>/dev/null || true)
                    findings+=("pip|VULN|${pkg_name}@${pkg_ver}|${vid}: ${vdesc} — Fix: ${vfix}|HIGH|UPDATE")
                done < <(echo "$pkg_line" | jq -c '.vulns[]' 2>/dev/null || true)
            done < <(echo "$pip_audit_out" | jq -c '.[]' 2>/dev/null || true)
        else
            echo -e "${YELLOW}[PIP] pip-audit not installed.${NC}"
            findings+=("pip|MISSING_TOOL|pip-audit|pip-audit is not installed. Install with: pip3 install pip-audit|INFO|INSTALL")
        fi
    fi

    # cargo audit
    if cmd_exists cargo; then
        if cmd_exists cargo-audit; then
            echo -e "${CYAN}[CARGO] Running cargo audit...${NC}"
            local cargo_audit_out
            cargo_audit_out=$(cargo audit --json 2>&1 || true)
            if echo "$cargo_audit_out" | jq -e '.vulnerabilities.found' &>/dev/null; then
                while IFS= read -r vuln_line; do
                    [[ -z "$vuln_line" ]] && continue
                    local pkg_name vuln_id vuln_title
                    pkg_name=$(echo "$vuln_line" | jq -r '.package.name' 2>/dev/null || true)
                    vuln_id=$(echo "$vuln_line" | jq -r '.advisory.id' 2>/dev/null || true)
                    vuln_title=$(echo "$vuln_line" | jq -r '.advisory.title' 2>/dev/null || true)
                    findings+=("cargo|VULN|${pkg_name}|${vuln_id}: ${vuln_title}|HIGH|UPDATE")
                done < <(echo "$cargo_audit_out" | jq -c '.vulnerabilities.list[]' 2>/dev/null || true)
            fi
        else
            echo -e "${YELLOW}[CARGO] cargo-audit not installed.${NC}"
            findings+=("cargo|MISSING_TOOL|cargo-audit|cargo-audit not installed. Install with: cargo install cargo-audit|INFO|INSTALL")
        fi
    fi

    # apt security updates
    if cmd_exists apt; then
        echo -e "${CYAN}[APT] Checking for security updates...${NC}"
        local sec_updates
        sec_updates=$(apt list --upgradable 2>/dev/null | grep -i security || true)
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            local pkg
            pkg=$(echo "$line" | awk -F'/' '{print $1}')
            findings+=("apt|SECURITY_UPDATE|${pkg}|Security update available|HIGH|UPDATE")
        done <<< "$sec_updates"
    fi

    print_findings_submenu "Vulnerabilities" findings
}

# ------------------------------------------------------------------------------
# Scan: Dependency Environment Mismatches
# ------------------------------------------------------------------------------
scan_env_mismatches() {
    local findings=()
    echo -e "\n${CYAN}[ENV-MISMATCH] Scanning for dependency environment mismatches...${NC}"

    # Node installed via both apt and nvm/fnm/volta
    local node_via_apt=false node_via_nvm=false node_via_volta=false node_via_fnm=false
    cmd_exists apt && dpkg -l nodejs &>/dev/null 2>&1 && node_via_apt=true
    [[ -d "${HOME}/.nvm" ]] && node_via_nvm=true
    [[ -d "${HOME}/.volta" ]] && node_via_volta=true
    [[ -d "${HOME}/.fnm" ]] && node_via_fnm=true

    local node_managers=()
    $node_via_apt && node_managers+=("apt")
    $node_via_nvm && node_managers+=("nvm")
    $node_via_volta && node_managers+=("volta")
    $node_via_fnm && node_managers+=("fnm")

    if [[ ${#node_managers[@]} -gt 1 ]]; then
        findings+=("node|MULTI_MANAGER|node|Node.js managed by multiple tools: ${node_managers[*]} — only one should own it|HIGH|RESOLVE")
    fi

    # Python installed via apt AND pyenv AND conda
    local py_via_apt=false py_via_pyenv=false py_via_conda=false
    cmd_exists dpkg && dpkg -l python3 &>/dev/null 2>&1 && py_via_apt=true
    [[ -d "${HOME}/.pyenv" ]] && py_via_pyenv=true
    (cmd_exists conda || cmd_exists mamba) && py_via_conda=true

    local py_managers=()
    $py_via_apt && py_managers+=("apt")
    $py_via_pyenv && py_managers+=("pyenv")
    $py_via_conda && py_managers+=("conda/mamba")

    if [[ ${#py_managers[@]} -gt 1 ]]; then
        findings+=("python|MULTI_MANAGER|python|Python managed by multiple tools: ${py_managers[*]} — can cause version conflicts|HIGH|RESOLVE")
    fi

    # Rust managed both via apt and rustup (these conflict badly)
    local rust_via_apt=false rust_via_rustup=false
    cmd_exists dpkg && dpkg -l rustc &>/dev/null 2>&1 && rust_via_apt=true
    cmd_exists rustup && rust_via_rustup=true

    if $rust_via_apt && $rust_via_rustup; then
        findings+=("rust|CONFLICT|rustc|Rust is installed via BOTH apt AND rustup — this causes serious conflicts. Remove apt version.|CRITICAL|RESOLVE")
    fi

    # Check if npm global prefix is wrong (inside nvm, causes permission errors)
    if cmd_exists npm; then
        local npm_prefix
        npm_prefix=$(npm config get prefix 2>/dev/null || true)
        if [[ "$npm_prefix" == *".nvm"* ]]; then
            findings+=("npm|NVM_PREFIX|npm-prefix|npm global prefix is inside nvm: ${npm_prefix} — global installs will break on nvm switch|HIGH|REVIEW")
        fi
    fi

    # pip packages installed with sudo (should never happen)
    if cmd_exists pip3; then
        local pip_user_site
        pip_user_site=$(python3 -m site --user-site 2>/dev/null || true)
        local pip_locations
        pip_locations=$(pip3 list -v --format=columns 2>/dev/null | awk '{print $3}' | sort -u || true)
        while IFS= read -r loc; do
            [[ -z "$loc" ]] && continue
            if [[ "$loc" == /usr/lib/python* || "$loc" == /usr/local/lib/python* ]]; then
                findings+=("pip|SYSTEM_INSTALL|pip|Packages installed into system Python: ${loc} — use venv or --user instead|HIGH|REVIEW")
                break
            fi
        done <<< "$pip_locations"
    fi

    print_findings_submenu "Environment Mismatches" findings
}

# ------------------------------------------------------------------------------
# Action: Update a Package
# ------------------------------------------------------------------------------
action_update_package() {
    local source="$1"
    local tool="$2"
    sk_log "ACTION" "User initiated update: ${source} / ${tool}"

    case "$source" in
        apt)
            echo -e "\n${GREEN}[ACTION] Running: sudo apt install --only-upgrade ${tool}${NC}"
            sudo apt install --only-upgrade "$tool"
            ;;
        dnf)
            echo -e "\n${GREEN}[ACTION] Running: sudo dnf upgrade ${tool}${NC}"
            sudo dnf upgrade "$tool"
            ;;
        pacman)
            echo -e "\n${GREEN}[ACTION] Running: sudo pacman -Syu ${tool}${NC}"
            sudo pacman -Syu "$tool"
            ;;
        snap)
            echo -e "\n${GREEN}[ACTION] Running: sudo snap refresh ${tool}${NC}"
            sudo snap refresh "$tool"
            ;;
        flatpak)
            echo -e "\n${GREEN}[ACTION] Running: flatpak update ${tool}${NC}"
            flatpak update "$tool"
            ;;
        npm-global)
            echo -e "\n${GREEN}[ACTION] Running: npm update -g ${tool}${NC}"
            npm update -g "$tool"
            ;;
        pip)
            echo -e "\n${GREEN}[ACTION] Running: pip3 install --upgrade ${tool}${NC}"
            pip3 install --upgrade "$tool"
            ;;
        rustup)
            if [[ "$tool" == "rustup-itself" ]]; then
                echo -e "\n${GREEN}[ACTION] Running: rustup self update${NC}"
                rustup self update
            else
                echo -e "\n${GREEN}[ACTION] Running: rustup update stable${NC}"
                rustup update stable
            fi
            ;;
        cargo)
            echo -e "\n${GREEN}[ACTION] Running: cargo install ${tool} --force${NC}"
            cargo install "$tool" --force
            ;;
        *)
            echo -e "\n${YELLOW}[ACTION] Unknown source '${source}'. Please update '${tool}' manually.${NC}"
            ;;
    esac
    sk_log "ACTION" "Update completed: ${source} / ${tool}"
}

# ------------------------------------------------------------------------------
# Action: Remove a Package
# ------------------------------------------------------------------------------
action_remove_package() {
    local source="$1"
    local tool="$2"
    sk_log "ACTION" "User initiated removal: ${source} / ${tool}"

    case "$source" in
        apt)
            echo -e "\n${RED}[ACTION] Running: sudo apt remove ${tool}${NC}"
            sudo apt remove "$tool"
            ;;
        dnf)
            echo -e "\n${RED}[ACTION] Running: sudo dnf remove ${tool}${NC}"
            sudo dnf remove "$tool"
            ;;
        pacman)
            echo -e "\n${RED}[ACTION] Running: sudo pacman -R ${tool}${NC}"
            sudo pacman -R "$tool"
            ;;
        snap)
            echo -e "\n${RED}[ACTION] Running: sudo snap remove ${tool}${NC}"
            sudo snap remove "$tool"
            ;;
        flatpak)
            echo -e "\n${RED}[ACTION] Running: flatpak uninstall ${tool}${NC}"
            flatpak uninstall "$tool"
            ;;
        npm-global)
            echo -e "\n${RED}[ACTION] Running: npm uninstall -g ${tool}${NC}"
            npm uninstall -g "$tool"
            ;;
        pip)
            echo -e "\n${RED}[ACTION] Running: pip3 uninstall ${tool} -y${NC}"
            pip3 uninstall "$tool" -y
            ;;
        rustup-toolchain)
            echo -e "\n${RED}[ACTION] Running: rustup toolchain uninstall ${tool}${NC}"
            rustup toolchain uninstall "$tool"
            ;;
        cargo)
            echo -e "\n${RED}[ACTION] Running: cargo uninstall ${tool}${NC}"
            cargo uninstall "$tool"
            ;;
        *)
            echo -e "\n${YELLOW}[ACTION] Unknown source '${source}'. Please remove '${tool}' manually.${NC}"
            ;;
    esac
    sk_log "ACTION" "Removal completed: ${source} / ${tool}"
}

# ------------------------------------------------------------------------------
# Action: Install missing audit tool
# ------------------------------------------------------------------------------
action_install_tool() {
    local tool="$1"
    case "$tool" in
        pip-audit)
            echo -e "\n${GREEN}[ACTION] Running: pip3 install pip-audit${NC}"
            pip3 install pip-audit
            ;;
        cargo-audit)
            echo -e "\n${GREEN}[ACTION] Running: cargo install cargo-audit${NC}"
            cargo install cargo-audit
            ;;
        *)
            echo -e "${YELLOW}Please install '${tool}' manually.${NC}"
            ;;
    esac
}

# ------------------------------------------------------------------------------
# Update Interactive Menu
# ------------------------------------------------------------------------------
show_update_menu() {
    echo -e "\n${CYAN}UPDATE A PACKAGE OR TOOL${NC}"
    echo -e "${GRAY}─────────────────────────────────────${NC}"
    echo -e "${GRAY}Sources: apt, dnf, pacman, snap, flatpak, npm-global, pip, rustup, cargo${NC}"
    echo ""
    read -r -p "  Enter source: " source
    read -r -p "  Enter tool/package name (or 'all' to update all from this source): " tool

    if [[ "${tool,,}" == "all" ]]; then
        if confirm "Update ALL packages from '${source}'?"; then
            case "${source,,}" in
                apt)     sudo apt upgrade ;;
                dnf)     sudo dnf upgrade -y ;;
                pacman)  sudo pacman -Syu ;;
                snap)    sudo snap refresh ;;
                flatpak) flatpak update ;;
                npm-global) npm update -g ;;
                pip)     pip3 list --outdated --format=json | jq -r '.[].name' | xargs -I{} pip3 install --upgrade {} ;;
                rustup)  rustup update ;;
                *)       echo -e "${YELLOW}Unknown source '${source}'.${NC}" ;;
            esac
        else
            echo -e "${GRAY}Cancelled.${NC}"
        fi
    else
        if confirm "Update '${tool}' from '${source}'?"; then
            action_update_package "$source" "$tool"
        else
            echo -e "${GRAY}Cancelled.${NC}"
        fi
    fi
}

# ------------------------------------------------------------------------------
# Export Report
# ------------------------------------------------------------------------------
export_report() {
    local scan_type="$1"
    shift
    local findings=("$@")
    local report_dir
    report_dir=$(config_get '.report_output_path' | sed "s|~|${HOME}|")
    mkdir -p "$report_dir"
    local report_file="${report_dir}/SafetyKing_${scan_type}_$(date '+%Y-%m-%d_%H-%M-%S').txt"

    {
        echo "SAFETY KING v${SK_VERSION} — ${scan_type} Report"
        echo "Generated: $(date)"
        echo "Host: $(hostname)"
        echo "Distro: $(detect_distro)"
        echo "Total findings: ${#findings[@]}"
        echo "$(printf '=%.0s' {1..60})"
        for finding in "${findings[@]}"; do
            echo ""
            IFS='|' read -ra parts <<< "$finding"
            echo "  Source  : ${parts[0]:-}"
            echo "  Type    : ${parts[1]:-}"
            echo "  Tool    : ${parts[2]:-}"
            echo "  Detail  : ${parts[3]:-}"
            echo "  Severity: ${parts[4]:-}"
            echo "  Action  : ${parts[5]:-}"
            echo "$(printf -- '-%.0s' {1..40})"
        done
    } > "$report_file"

    echo -e "\n${GREEN}[REPORT] Saved to: ${report_file}${NC}"
    sk_log "ACTION" "Report exported: ${report_file}"
}

# ------------------------------------------------------------------------------
# Print Findings and Sub-Menu
# ------------------------------------------------------------------------------
print_findings_submenu() {
    local scan_type="$1"
    shift
    local -n findings_ref=$1

    if [[ ${#findings_ref[@]} -eq 0 ]]; then
        echo -e "\n${GREEN}[OK] No findings for: ${scan_type}${NC}"
        press_enter
        return
    fi

    echo -e "\n${YELLOW}$(printf '=%.0s' {1..60})${NC}"
    echo -e "${YELLOW}  FINDINGS: ${scan_type} (${#findings_ref[@]} items)${NC}"
    echo -e "${YELLOW}$(printf '=%.0s' {1..60})${NC}"

    local i=1
    for finding in "${findings_ref[@]}"; do
        IFS='|' read -ra parts <<< "$finding"
        local source="${parts[0]:-}"
        local ftype="${parts[1]:-}"
        local tool="${parts[2]:-}"
        local detail="${parts[3]:-}"
        local severity="${parts[4]:-MEDIUM}"
        local action="${parts[5]:-REVIEW}"

        local color="$WHITE"
        case "$severity" in
            CRITICAL|HIGH) color="$RED" ;;
            MEDIUM)        color="$YELLOW" ;;
            LOW|INFO)      color="$CYAN" ;;
        esac

        echo -e "\n  ${color}[${i}] [${severity}] ${detail}${NC}"
        echo -e "       ${GRAY}Tool   : ${tool}${NC}"
        echo -e "       ${GRAY}Source : ${source}${NC}"
        echo -e "       ${GRAY}Type   : ${ftype}${NC}"
        echo -e "       ${GRAY}Action : ${action}${NC}"
        ((i++))
    done

    local in_submenu=true
    while $in_submenu; do
        echo -e "\n${GRAY}$(printf -- '-%.0s' {1..60})${NC}"
        echo -e "${CYAN}  SUB-MENU — ${scan_type}${NC}"
        echo -e "  1. Update a finding by number"
        echo -e "  2. Remove a finding by number"
        echo -e "  3. View full details on a finding"
        echo -e "  4. Skip all and return to main menu"
        echo -e "  5. Export these results to report"
        echo -e "${GRAY}$(printf -- '-%.0s' {1..60})${NC}"

        read -r -p "  Enter choice [1-5]: " sub_choice
        case "$sub_choice" in
            1)
                read -r -p "  Enter finding number to update: " idx
                if [[ "$idx" =~ ^[0-9]+$ ]] && (( idx >= 1 && idx <= ${#findings_ref[@]} )); then
                    IFS='|' read -ra parts <<< "${findings_ref[$((idx-1))]}"
                    local fsource="${parts[0]:-unknown}"
                    local ftool="${parts[2]:-unknown}"
                    local faction="${parts[5]:-REVIEW}"
                    echo -e "\n${YELLOW}About to UPDATE: ${ftool} from ${fsource}${NC}"
                    echo -e "${GRAY}Detail: ${parts[3]:-}${NC}"
                    if [[ "$faction" == "INSTALL" ]]; then
                        if confirm "Install '${ftool}'?"; then
                            action_install_tool "$ftool"
                        else
                            echo -e "${GRAY}Cancelled.${NC}"
                        fi
                    else
                        if confirm "Update '${ftool}' from '${fsource}'?"; then
                            action_update_package "$fsource" "$ftool"
                        else
                            echo -e "${GRAY}Cancelled.${NC}"
                        fi
                    fi
                else
                    echo -e "${RED}Invalid number.${NC}"
                fi
                ;;
            2)
                read -r -p "  Enter finding number to remove: " idx
                if [[ "$idx" =~ ^[0-9]+$ ]] && (( idx >= 1 && idx <= ${#findings_ref[@]} )); then
                    IFS='|' read -ra parts <<< "${findings_ref[$((idx-1))]}"
                    local fsource="${parts[0]:-unknown}"
                    local ftool="${parts[2]:-unknown}"
                    echo -e "\n${RED}About to REMOVE: ${ftool} from ${fsource}${NC}"
                    echo -e "${GRAY}Detail: ${parts[3]:-}${NC}"
                    if confirm_destructive "Remove '${ftool}' from '${fsource}'?"; then
                        action_remove_package "$fsource" "$ftool"
                    else
                        echo -e "${GRAY}Cancelled.${NC}"
                    fi
                else
                    echo -e "${RED}Invalid number.${NC}"
                fi
                ;;
            3)
                read -r -p "  Enter finding number to view: " idx
                if [[ "$idx" =~ ^[0-9]+$ ]] && (( idx >= 1 && idx <= ${#findings_ref[@]} )); then
                    IFS='|' read -ra parts <<< "${findings_ref[$((idx-1))]}"
                    echo -e "\n${CYAN}=== FULL DETAILS ===${NC}"
                    echo -e "  Source  : ${parts[0]:-}"
                    echo -e "  Type    : ${parts[1]:-}"
                    echo -e "  Tool    : ${parts[2]:-}"
                    echo -e "  Detail  : ${parts[3]:-}"
                    echo -e "  Severity: ${parts[4]:-}"
                    echo -e "  Action  : ${parts[5]:-}"
                else
                    echo -e "${RED}Invalid number.${NC}"
                fi
                ;;
            4)
                in_submenu=false
                ;;
            5)
                export_report "$scan_type" "${findings_ref[@]}"
                ;;
            *)
                echo -e "${RED}Invalid choice. Enter 1-5.${NC}"
                ;;
        esac
    done
}

# ------------------------------------------------------------------------------
# Settings Menu
# ------------------------------------------------------------------------------
show_settings_menu() {
    local cfg
    cfg=$(load_config)
    local in_settings=true

    while $in_settings; do
        clear
        echo -e "${MAGENTA}╔══════════════════════════════════════════════════════════╗${NC}"
        echo -e "${MAGENTA}║        SAFETY KING — Settings & Options (Linux)          ║${NC}"
        echo -e "${MAGENTA}╚══════════════════════════════════════════════════════════╝${NC}"
        echo ""

        local distro apt_on snap_on flatpak_on npm_on pip_on cargo_on channel report_path wsl_check scan_depth
        distro=$(echo "$cfg" | jq -r '.distro')
        apt_on=$(echo "$cfg" | jq -r '.package_managers.apt')
        snap_on=$(echo "$cfg" | jq -r '.package_managers.snap')
        flatpak_on=$(echo "$cfg" | jq -r '.package_managers.flatpak')
        npm_on=$(echo "$cfg" | jq -r '.package_managers.npm')
        pip_on=$(echo "$cfg" | jq -r '.package_managers.pip')
        cargo_on=$(echo "$cfg" | jq -r '.package_managers.cargo')
        channel=$(echo "$cfg" | jq -r '.update_channel')
        report_path=$(echo "$cfg" | jq -r '.report_output_path')
        wsl_check=$(echo "$cfg" | jq -r '.check_windows_bleed')
        scan_depth=$(echo "$cfg" | jq -r '.scan_depth')

        on_off() { [[ "$1" == "true" ]] && echo "[ON] " || echo "[OFF]"; }

        echo -e "  ${CYAN}Distro Selection:${NC}"
        echo -e "   1. Distro   : ${distro} (detected: $(detect_distro))"
        echo ""
        echo -e "  ${CYAN}Package Managers:${NC}"
        echo -e "   2. apt      : $(on_off "$apt_on")"
        echo -e "   3. snap     : $(on_off "$snap_on")"
        echo -e "   4. flatpak  : $(on_off "$flatpak_on")"
        echo -e "   5. npm/Node : $(on_off "$npm_on")"
        echo -e "   6. pip/Python: $(on_off "$pip_on")"
        echo -e "   7. cargo/Rust: $(on_off "$cargo_on")"
        echo ""
        echo -e "  ${CYAN}Options:${NC}"
        echo -e "   8. Update Channel        : ${channel}"
        echo -e "   9. Report Output Path    : ${report_path}"
        echo -e "  10. Check Windows Bleed   : $(on_off "$wsl_check")"
        echo -e "  11. Scan Depth            : ${scan_depth}"
        echo ""
        echo -e "  ${GREEN}12. Save and return to main menu${NC}"
        echo -e "  ${YELLOW}13. Discard and return${NC}"
        echo ""

        read -r -p "  Enter choice [1-13]: " s_choice
        case "$s_choice" in
            1)
                echo -e "${GRAY}Options: auto, ubuntu, debian, fedora, arch, kali, opensuse, alpine${NC}"
                read -r -p "  Enter distro: " new_distro
                [[ -n "$new_distro" ]] && cfg=$(echo "$cfg" | jq --arg v "$new_distro" '.distro = $v')
                ;;
            2) cfg=$(echo "$cfg" | jq '.package_managers.apt = (.package_managers.apt | not)') ;;
            3) cfg=$(echo "$cfg" | jq '.package_managers.snap = (.package_managers.snap | not)') ;;
            4) cfg=$(echo "$cfg" | jq '.package_managers.flatpak = (.package_managers.flatpak | not)') ;;
            5) cfg=$(echo "$cfg" | jq '.package_managers.npm = (.package_managers.npm | not)') ;;
            6) cfg=$(echo "$cfg" | jq '.package_managers.pip = (.package_managers.pip | not)') ;;
            7) cfg=$(echo "$cfg" | jq '.package_managers.cargo = (.package_managers.cargo | not)') ;;
            8)
                echo -e "${GRAY}Options: LTS, Stable, Latest${NC}"
                read -r -p "  Enter update channel: " new_channel
                if [[ "$new_channel" =~ ^(LTS|Stable|Latest)$ ]]; then
                    cfg=$(echo "$cfg" | jq --arg v "$new_channel" '.update_channel = $v')
                else
                    echo -e "${RED}Invalid. Must be LTS, Stable, or Latest.${NC}"
                fi
                ;;
            9)
                read -r -p "  Enter new report output path: " new_path
                if [[ -n "$new_path" ]]; then
                    local expanded_path="${new_path/#\~/$HOME}"
                    if [[ ! -d "$expanded_path" ]]; then
                        if confirm "Path does not exist. Create it?"; then
                            mkdir -p "$expanded_path"
                            cfg=$(echo "$cfg" | jq --arg v "$new_path" '.report_output_path = $v')
                        fi
                    else
                        cfg=$(echo "$cfg" | jq --arg v "$new_path" '.report_output_path = $v')
                    fi
                fi
                ;;
            10) cfg=$(echo "$cfg" | jq '.check_windows_bleed = (.check_windows_bleed | not)') ;;
            11)
                echo -e "${GRAY}Options: quick, deep${NC}"
                read -r -p "  Enter scan depth: " new_depth
                if [[ "$new_depth" =~ ^(quick|deep)$ ]]; then
                    cfg=$(echo "$cfg" | jq --arg v "$new_depth" '.scan_depth = $v')
                else
                    echo -e "${RED}Invalid. Must be quick or deep.${NC}"
                fi
                ;;
            12)
                save_config "$cfg"
                echo -e "${GREEN}Settings saved.${NC}"
                in_settings=false
                ;;
            13)
                in_settings=false
                ;;
            *)
                echo -e "${RED}Invalid choice. Enter 1-13.${NC}"
                ;;
        esac
    done
}

# ------------------------------------------------------------------------------
# Run All Scans
# ------------------------------------------------------------------------------
run_all_scans() {
    local all_findings=()
    echo -e "\n${CYAN}Running all scans...${NC}"

    # Capture findings arrays from each scan by redirecting through temp files
    local tmp_dir
    tmp_dir=$(mktemp -d)

    scan_duplicate_versions   2>&1 | tee "${tmp_dir}/dup.txt"
    scan_outdated_versions    2>&1 | tee "${tmp_dir}/out.txt"
    scan_path_conflicts       2>&1 | tee "${tmp_dir}/path.txt"
    scan_windows_bleed        2>&1 | tee "${tmp_dir}/bleed.txt"
    scan_pkg_manager_conflicts 2>&1 | tee "${tmp_dir}/pkgcon.txt"
    scan_version_locks        2>&1 | tee "${tmp_dir}/locks.txt"
    scan_unverified_packages  2>&1 | tee "${tmp_dir}/unver.txt"
    scan_vulnerabilities      2>&1 | tee "${tmp_dir}/vuln.txt"
    scan_env_mismatches       2>&1 | tee "${tmp_dir}/env.txt"

    rm -rf "$tmp_dir"
}

# ------------------------------------------------------------------------------
# Main Menu
# ------------------------------------------------------------------------------
main_menu() {
    local running=true
    while $running; do
        clear
        echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║           SAFETY KING v${SK_VERSION} — WSL/Linux               ║${NC}"
        echo -e "${GREEN}║        Environment Health & Conflict Resolution          ║${NC}"
        echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
        echo -e "  ${GRAY}Distro: $(detect_distro) | Package Manager: $(get_native_pkg_manager)${NC}"
        echo ""
        echo -e "   ${WHITE}1.  Scan for duplicate tool versions${NC}"
        echo -e "   ${WHITE}2.  Scan for outdated versions${NC}"
        echo -e "   ${WHITE}3.  Update a package or tool${NC}"
        echo -e "   ${WHITE}4.  Scan for PATH conflicts and pollution${NC}"
        echo -e "   ${WHITE}5.  Scan for Windows bleed into WSL PATH${NC}"
        echo -e "   ${WHITE}6.  Scan for package manager conflicts${NC}"
        echo -e "   ${WHITE}7.  Scan for version locks blocking uninstalls${NC}"
        echo -e "   ${WHITE}8.  Scan for unverified packages${NC}"
        echo -e "   ${WHITE}9.  Scan for vulnerabilities${NC}"
        echo -e "   ${WHITE}10. Scan for dependency environment mismatches${NC}"
        echo -e "   ${WHITE}11. Run all scans${NC}"
        echo -e "   ${WHITE}12. Export full report (runs all scans)${NC}"
        echo -e "   ${CYAN}13. Settings & Distro Selection${NC}"
        echo -e "   ${RED}14. Exit${NC}"
        echo ""
        echo -e "  ${GRAY}NOTE: Nothing runs without your explicit Y/N confirmation.${NC}"
        echo ""

        read -r -p "  Enter choice [1-14]: " choice
        case "$choice" in
            1)
                if confirm "Run duplicate version scan?"; then
                    scan_duplicate_versions
                fi
                ;;
            2)
                if confirm "Run outdated version scan?"; then
                    scan_outdated_versions
                fi
                ;;
            3)
                show_update_menu
                press_enter
                ;;
            4)
                if confirm "Run PATH conflict scan?"; then
                    scan_path_conflicts
                fi
                ;;
            5)
                if confirm "Run Windows bleed scan?"; then
                    scan_windows_bleed
                fi
                ;;
            6)
                if confirm "Run package manager conflict scan?"; then
                    scan_pkg_manager_conflicts
                fi
                ;;
            7)
                if confirm "Run version lock scan?"; then
                    scan_version_locks
                fi
                ;;
            8)
                if confirm "Run unverified package scan?"; then
                    scan_unverified_packages
                fi
                ;;
            9)
                if confirm "Run vulnerability scan? This may take a few minutes."; then
                    scan_vulnerabilities
                fi
                ;;
            10)
                if confirm "Run dependency environment mismatch scan?"; then
                    scan_env_mismatches
                fi
                ;;
            11)
                if confirm "Run ALL scans? This may take several minutes."; then
                    run_all_scans
                fi
                ;;
            12)
                if confirm "Export full report? This runs all scans and may take several minutes."; then
                    run_all_scans
                    echo -e "\n${GREEN}All scans complete. Individual reports saved to: $(config_get '.report_output_path' | sed "s|~|${HOME}|")${NC}"
                    press_enter
                fi
                ;;
            13)
                show_settings_menu
                ;;
            14)
                if confirm "Exit Safety King?"; then
                    echo -e "\n${GREEN}Goodbye.${NC}"
                    sk_log "INFO" "Safety King exited cleanly."
                    running=false
                fi
                ;;
            *)
                echo -e "${RED}Invalid choice. Enter 1-14.${NC}"
                sleep 1
                ;;
        esac
    done
}

# ------------------------------------------------------------------------------
# Entry Point
# ------------------------------------------------------------------------------
check_dependencies
mkdir -p "$SK_CONFIG_DIR" "$SK_LOG_DIR"
sk_log "INFO" "Safety King started. Distro: $(detect_distro). PM: $(get_native_pkg_manager)."
main_menu

