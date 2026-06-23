#!/bin/bash

set -e

echo "🛡️  WAF Microservice Installation Script"
echo "========================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root or with sudo"
    exit 1
fi

# Install Rust if not present
if ! command -v cargo &> /dev/null; then
    echo "📦 Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi

# Build the project
echo "🔨 Building WAF..."
cargo build --release

# Create waf user
if ! id "waf" &>/dev/null; then
    echo "👤 Creating waf user..."
    useradd -r -s /bin/false waf
fi

# Create directories
echo "📁 Creating directories..."
mkdir -p /opt/waf/{data,logs}
mkdir -p /etc/waf

# Copy files
echo "📋 Installing files..."
cp target/release/waf-microservice /opt/waf/
cp config.toml /etc/waf/
ln -sf /etc/waf/config.toml /opt/waf/config.toml

# Set permissions
echo "🔒 Setting permissions..."
chown -R waf:waf /opt/waf
chmod 750 /opt/waf
chmod 640 /opt/waf/waf-microservice

# Install systemd service
echo "⚙️  Installing systemd service..."
cp waf.service /etc/systemd/system/
systemctl daemon-reload

# Enable and start service
echo "🚀 Enabling and starting service..."
systemctl enable waf
systemctl start waf

# Wait a moment for startup
sleep 2

# Check status
if systemctl is-active --quiet waf; then
    echo ""
    echo "✅ WAF Microservice installed and running!"
    echo ""
    echo "Commands:"
    echo "  Status:  systemctl status waf"
    echo "  Logs:    journalctl -u waf -f"
    echo "  Stop:    systemctl stop waf"
    echo "  Restart: systemctl restart waf"
    echo ""
    echo "Configuration: /etc/waf/config.toml"
    echo "Data directory: /opt/waf/data"
    echo "Logs directory: /opt/waf/logs"
    echo ""
    echo "API endpoints available at http://localhost:8080/waf/"
else
    echo ""
    echo "❌ Service failed to start. Check logs:"
    echo "  journalctl -u waf -n 50"
    exit 1
fi
