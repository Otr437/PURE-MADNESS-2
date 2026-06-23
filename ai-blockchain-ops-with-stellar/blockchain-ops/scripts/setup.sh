#!/usr/bin/env bash
# ============================================================
# SETUP — Fresh server setup for AI Blockchain Ops
# Ubuntu 24.04 LTS / Debian 12
# Usage: sudo ./scripts/setup.sh
# ============================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

if [[ $EUID -ne 0 ]]; then
  echo -e "${RED}Must run as root: sudo ./scripts/setup.sh${RESET}"
  exit 1
fi

echo -e "${BOLD}${CYAN}AI Blockchain Ops — Server Setup${RESET}"
echo ""

# ── System update ─────────────────────────────────────────────
echo -e "${CYAN}Updating system...${RESET}"
apt-get update -qq
apt-get upgrade -y -qq

# ── Install dependencies ──────────────────────────────────────
echo -e "${CYAN}Installing dependencies...${RESET}"
apt-get install -y -qq \
  curl wget git build-essential python3 \
  nginx postgresql-16 certbot python3-certbot-nginx \
  ufw fail2ban htop unzip

# ── Node.js 22 ───────────────────────────────────────────────
echo -e "${CYAN}Installing Node.js 22 LTS...${RESET}"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs
node --version && npm --version

# ── Install tsx globally ──────────────────────────────────────
npm install -g tsx typescript

# ── Install Foundry (forge/cast) ──────────────────────────────
echo -e "${CYAN}Installing Foundry...${RESET}"
curl -L https://foundry.paradigm.xyz | bash
export PATH="$HOME/.foundry/bin:$PATH"
foundryup || echo "Run 'foundryup' manually after setup"

# ── Create system user ────────────────────────────────────────
echo -e "${CYAN}Creating aiops user...${RESET}"
id -u aiops &>/dev/null || useradd -r -s /bin/bash -d /opt/aiops -m aiops

# ── Create directories ────────────────────────────────────────
mkdir -p /opt/aiops/logs /opt/aiops/.blockchain-workspace
chown -R aiops:aiops /opt/aiops

# ── PostgreSQL setup ──────────────────────────────────────────
echo -e "${CYAN}Setting up PostgreSQL...${RESET}"
systemctl start postgresql
systemctl enable postgresql

# Create database user and database
sudo -u postgres psql << 'PSQL'
CREATE USER aiops WITH PASSWORD 'CHANGE_THIS_PASSWORD';
CREATE DATABASE aiblockchain OWNER aiops;
GRANT ALL PRIVILEGES ON DATABASE aiblockchain TO aiops;
\c aiblockchain
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
PSQL
echo -e "${YELLOW}⚠  Change the PostgreSQL password in /etc/postgresql/16/main/pg_hba.conf${RESET}"

# ── UFW Firewall ──────────────────────────────────────────────
echo -e "${CYAN}Configuring firewall...${RESET}"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
# Internal module ports are NOT exposed — only nginx gets external traffic
ufw --force enable
echo -e "${GREEN}✅ Firewall configured — only SSH, HTTP, HTTPS allowed${RESET}"

# ── Fail2ban ──────────────────────────────────────────────────
echo -e "${CYAN}Configuring fail2ban...${RESET}"
cat > /etc/fail2ban/jail.local << 'F2B'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true

[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled = true
filter = nginx-limit-req
action = iptables-multiport[name=nginx-limit-req, port="http,https"]
logpath = /var/log/nginx/error.log
maxretry = 10
F2B
systemctl restart fail2ban

# ── SSL Certificate (Let's Encrypt) ──────────────────────────
DOMAIN=${1:-}
if [[ -n "$DOMAIN" ]]; then
  echo -e "${CYAN}Obtaining SSL certificate for $DOMAIN...${RESET}"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN"
else
  echo -e "${YELLOW}⚠  No domain provided — generate self-signed cert:${RESET}"
  echo -e "   ${YELLOW}openssl req -x509 -newkey rsa:4096 -keyout nginx/certs/privkey.pem -out nginx/certs/fullchain.pem -days 365 -nodes -subj '/CN=localhost'${RESET}"
fi

# ── Copy app files ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo -e "${CYAN}Copying app to /opt/aiops...${RESET}"
cp -r "$ROOT_DIR"/* /opt/aiops/
chown -R aiops:aiops /opt/aiops
chmod +x /opt/aiops/scripts/*.sh

# ── Install npm dependencies ──────────────────────────────────
cd /opt/aiops
sudo -u aiops npm install --omit=dev

# ── Install systemd service ───────────────────────────────────
echo -e "${CYAN}Installing systemd service...${RESET}"
cp /opt/aiops/scripts/aiops.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable aiops

# ── Copy nginx config ─────────────────────────────────────────
cp /opt/aiops/nginx.conf /etc/nginx/nginx.conf
nginx -t && systemctl restart nginx

echo ""
echo -e "${GREEN}${BOLD}✅ Setup complete!${RESET}"
echo ""
echo -e "  Next steps:"
echo -e "  1. ${YELLOW}cp /opt/aiops/.env.example /opt/aiops/.env${RESET}"
echo -e "  2. ${YELLOW}nano /opt/aiops/.env${RESET}  (fill in all API keys)"
echo -e "  3. ${YELLOW}mkdir -p /opt/aiops/nginx/certs${RESET}  (add SSL certs)"
echo -e "  4. ${YELLOW}sudo systemctl start aiops${RESET}"
echo -e "  5. ${YELLOW}sudo systemctl status aiops${RESET}"
echo -e "  6. Open ${CYAN}https://your-domain.com${RESET}"
