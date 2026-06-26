// PM2 ecosystem configuration for PEAQ FORGE v1
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 stop peaq-forge
//   pm2 restart peaq-forge
//   pm2 logs peaq-forge
//   pm2 monit
//   pm2 save && pm2 startup   (auto-start on reboot)

module.exports = {
  apps: [
    {
      name:             "peaq-forge",
      script:           "server.js",
      cwd:              __dirname,
      instances:        1,           // single instance — WebSocket state is per-process
      exec_mode:        "fork",
      node_args:        "--max-old-space-size=512",

      // ── Environment ──────────────────────────────────────────────────────
      env: {
        NODE_ENV: "production",
        PORT:     "3048",
        HOST:     "127.0.0.1",
      },
      env_production: {
        NODE_ENV: "production",
        PORT:     "3048",
        HOST:     "127.0.0.1",
      },
      env_development: {
        NODE_ENV:  "development",
        PORT:      "3048",
        HOST:      "127.0.0.1",
        LOG_LEVEL: "debug",
      },

      // ── Restart policy ────────────────────────────────────────────────────
      autorestart:       true,
      watch:             false,      // never watch in production
      max_memory_restart: "512M",
      restart_delay:     3000,       // 3s between restarts
      max_restarts:      10,
      min_uptime:        "10s",

      // ── Logging ───────────────────────────────────────────────────────────
      log_date_format:  "YYYY-MM-DD HH:mm:ss",
      out_file:         "./logs/pm2-out.log",
      error_file:       "./logs/pm2-error.log",
      merge_logs:       true,
      log_type:         "json",

      // ── Signals ───────────────────────────────────────────────────────────
      kill_timeout:     5000,        // ms to wait for graceful shutdown before SIGKILL
      listen_timeout:   10000,
      shutdown_with_message: false,

      // ── Health monitoring ─────────────────────────────────────────────────
      // Exposes /api/health for PM2 health check
      exp_backoff_restart_delay: 100,
    },
  ],
};
