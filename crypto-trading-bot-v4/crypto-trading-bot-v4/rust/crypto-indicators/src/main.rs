// src/main.rs
// Binary entry point. Initialises logging, sets up panic handler,
// enforces resource limits, then hands off to the bridge run loop.
// Exits with code 0 on clean shutdown (stdin closed).
// Exits with code 1 on any unrecoverable startup error.

#![deny(unused_unsafe)]

use std::env;
use std::io::Write;

fn main() {
    // ── Initialise logging ────────────────────────────────────────────────────
    // All log output goes to stderr. stdout is reserved exclusively for the
    // JSON bridge protocol. This keeps the protocol channel uncontaminated.
    env_logger::Builder::new()
        .target(env_logger::Target::Stderr)
        .filter_level(log_level_from_env())
        .format(|buf, record| {
            writeln!(
                buf,
                "[{}][{}][{}:{}] {}",
                chrono_now(),
                record.level(),
                record.file().unwrap_or("?"),
                record.line().unwrap_or(0),
                record.args()
            )
        })
        .init();

    // ── Panic handler: print to stderr then exit cleanly ──────────────────────
    // Default panic handler can write to stdout which would corrupt the protocol.
    std::panic::set_hook(Box::new(|info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic".to_string()
        };
        let location = info.location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown location".to_string());
        eprintln!("[FATAL] Panic at {location}: {msg}");
        std::process::exit(1);
    }));

    // ── Print startup banner to stderr ────────────────────────────────────────
    log::info!(
        "crypto-indicators v{} starting up (pid={})",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    );
    log::info!("Build: {} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
    log::info!("Log level: {:?}", log_level_from_env());

    // ── Validate environment before accepting requests ─────────────────────────
    if let Err(e) = validate_environment() {
        log::error!("Environment validation failed: {e}");
        std::process::exit(1);
    }

    // ── Run the stdin/stdout bridge loop ──────────────────────────────────────
    // This blocks until stdin is closed (i.e. the Node.js parent process exits).
    crypto_indicators::bridge::run_bridge();

    log::info!("Bridge exited cleanly.");
    std::process::exit(0);
}

// ── LOG LEVEL FROM ENV ────────────────────────────────────────────────────────

fn log_level_from_env() -> log::LevelFilter {
    match env::var("RUST_LOG").as_deref().unwrap_or("info").to_lowercase().as_str() {
        "trace" => log::LevelFilter::Trace,
        "debug" => log::LevelFilter::Debug,
        "info"  => log::LevelFilter::Info,
        "warn"  => log::LevelFilter::Warn,
        "error" => log::LevelFilter::Error,
        "off"   => log::LevelFilter::Off,
        _       => log::LevelFilter::Info,
    }
}

// ── ENVIRONMENT VALIDATION ────────────────────────────────────────────────────

fn validate_environment() -> Result<(), String> {
    // Verify we can write to stdout (bridge channel)
    if let Err(e) = std::io::stdout().flush() {
        return Err(format!("stdout not writable: {e}"));
    }
    // Verify stdin is not a terminal (should be piped from Node.js)
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let fd = std::io::stdin().as_raw_fd();
        // isatty returns 1 if fd is a terminal — we want it to NOT be a terminal
        let is_tty = unsafe { libc_isatty(fd) };
        if is_tty == 1 {
            log::warn!(
                "stdin appears to be a terminal. The bridge expects to be piped from Node.js. \
                 Running in interactive mode — type JSON requests manually, Ctrl+D to exit."
            );
        }
    }
    Ok(())
}

// Minimal FFI stub for isatty — avoids pulling in the full libc crate.
// Only compiled on Unix targets.
#[cfg(unix)]
extern "C" {
    #[link_name = "isatty"]
    fn libc_isatty(fd: i32) -> i32;
}

// ── SIMPLE TIMESTAMP FOR LOG FORMAT ──────────────────────────────────────────

fn chrono_now() -> String {
    use chrono::Utc;
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}
