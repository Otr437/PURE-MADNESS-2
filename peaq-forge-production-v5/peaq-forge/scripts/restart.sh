#!/usr/bin/env bash
pkill -f "node server.js" 2>/dev/null || true
sleep 1
echo "Restarting PEAQ FORGE v1..."
NODE_ENV=production node server.js
