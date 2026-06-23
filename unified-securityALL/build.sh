#!/bin/bash

set -e

echo "🔨 Building WAF Microservice..."
echo ""

# Check Rust installation
if ! command -v cargo &> /dev/null; then
    echo "❌ Rust not found. Installing..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi

echo "✓ Rust found: $(rustc --version)"
echo ""

# Build in release mode
echo "Building in release mode..."
cargo build --release

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Build successful!"
    echo ""
    echo "Binary location: target/release/waf-microservice"
    echo "Size: $(du -h target/release/waf-microservice | cut -f1)"
    echo ""
    echo "Quick start commands:"
    echo "  Run locally:     cargo run --release"
    echo "  Run binary:      ./target/release/waf-microservice"
    echo "  Docker build:    docker build -t waf ."
    echo "  Docker compose:  docker-compose up -d"
    echo "  Install system:  sudo ./install.sh"
    echo ""
    echo "Next steps:"
    echo "  1. Edit config.toml to configure backends"
    echo "  2. Run ./target/release/waf-microservice"
    echo "  3. Test with ./test_waf.sh"
    echo "  4. Monitor at http://localhost:8080/waf/metrics"
else
    echo ""
    echo "❌ Build failed!"
    echo "Check the error messages above."
    exit 1
fi
