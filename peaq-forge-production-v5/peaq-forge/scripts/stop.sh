#!/usr/bin/env bash
pkill -f "node server.js" && echo "PEAQ FORGE stopped." || echo "No process found."
