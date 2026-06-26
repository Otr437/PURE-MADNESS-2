use anyhow::{Context, Result};
use prometheus::{
    CounterVec, GaugeVec, HistogramOpts, HistogramVec, Opts, Registry,
};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct LbMetrics {
    pub registry: Arc<Registry>,
    pub requests_total: CounterVec,
    pub requests_in_flight: GaugeVec,
    pub request_duration_seconds: HistogramVec,
    pub backend_connections_active: GaugeVec,
    pub backend_requests_total: CounterVec,
    pub backend_errors_total: CounterVec,
    pub backend_health_status: GaugeVec,
    pub circuit_breaker_state: GaugeVec,
    pub shard_requests_total: CounterVec,
    pub upstream_latency_seconds: HistogramVec,
    pub rate_limit_hits_total: CounterVec,
}

impl LbMetrics {
    pub fn new() -> Result<Self> {
        let registry = Registry::new();

        let requests_total = CounterVec::new(
            Opts::new("lb_requests_total", "Total number of requests received"),
            &["method", "path", "status_code", "algorithm"],
        )
        .context("creating requests_total counter")?;

        let requests_in_flight = GaugeVec::new(
            Opts::new("lb_requests_in_flight", "Number of in-flight requests"),
            &["algorithm"],
        )
        .context("creating requests_in_flight gauge")?;

        let request_duration_seconds = HistogramVec::new(
            HistogramOpts::new(
                "lb_request_duration_seconds",
                "Request duration including upstream latency",
            )
            .buckets(vec![
                0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
            ]),
            &["method", "status_class"],
        )
        .context("creating request_duration histogram")?;

        let backend_connections_active = GaugeVec::new(
            Opts::new(
                "lb_backend_connections_active",
                "Active connections per backend",
            ),
            &["backend_id"],
        )
        .context("creating backend_connections_active gauge")?;

        let backend_requests_total = CounterVec::new(
            Opts::new(
                "lb_backend_requests_total",
                "Total requests forwarded to each backend",
            ),
            &["backend_id", "algorithm"],
        )
        .context("creating backend_requests_total counter")?;

        let backend_errors_total = CounterVec::new(
            Opts::new(
                "lb_backend_errors_total",
                "Total errors from each backend",
            ),
            &["backend_id", "error_kind"],
        )
        .context("creating backend_errors_total counter")?;

        let backend_health_status = GaugeVec::new(
            Opts::new(
                "lb_backend_health_status",
                "Backend health: 1=healthy, 0=unhealthy",
            ),
            &["backend_id"],
        )
        .context("creating backend_health_status gauge")?;

        let circuit_breaker_state = GaugeVec::new(
            Opts::new(
                "lb_circuit_breaker_state",
                "Circuit breaker state: 0=closed, 1=open, 2=half_open",
            ),
            &["backend_id"],
        )
        .context("creating circuit_breaker_state gauge")?;

        let shard_requests_total = CounterVec::new(
            Opts::new(
                "lb_shard_requests_total",
                "Total requests routed to each shard",
            ),
            &["shard_id"],
        )
        .context("creating shard_requests_total counter")?;

        let upstream_latency_seconds = HistogramVec::new(
            HistogramOpts::new(
                "lb_upstream_latency_seconds",
                "Latency for upstream backend responses",
            )
            .buckets(vec![
                0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0,
            ]),
            &["backend_id"],
        )
        .context("creating upstream_latency histogram")?;

        let rate_limit_hits_total = CounterVec::new(
            Opts::new(
                "lb_rate_limit_hits_total",
                "Total number of rate-limited requests",
            ),
            &["key"],
        )
        .context("creating rate_limit_hits_total counter")?;

        registry.register(Box::new(requests_total.clone()))?;
        registry.register(Box::new(requests_in_flight.clone()))?;
        registry.register(Box::new(request_duration_seconds.clone()))?;
        registry.register(Box::new(backend_connections_active.clone()))?;
        registry.register(Box::new(backend_requests_total.clone()))?;
        registry.register(Box::new(backend_errors_total.clone()))?;
        registry.register(Box::new(backend_health_status.clone()))?;
        registry.register(Box::new(circuit_breaker_state.clone()))?;
        registry.register(Box::new(shard_requests_total.clone()))?;
        registry.register(Box::new(upstream_latency_seconds.clone()))?;
        registry.register(Box::new(rate_limit_hits_total.clone()))?;

        Ok(Self {
            registry: Arc::new(registry),
            requests_total,
            requests_in_flight,
            request_duration_seconds,
            backend_connections_active,
            backend_requests_total,
            backend_errors_total,
            backend_health_status,
            circuit_breaker_state,
            shard_requests_total,
            upstream_latency_seconds,
            rate_limit_hits_total,
        })
    }

    pub fn render(&self) -> Result<String> {
        use prometheus::Encoder;
        let encoder = prometheus::TextEncoder::new();
        let mut buffer = Vec::new();
        let mf = self.registry.gather();
        encoder
            .encode(&mf, &mut buffer)
            .context("encoding metrics")?;
        String::from_utf8(buffer).context("metrics output is not valid UTF-8")
    }

    pub fn record_request(
        &self,
        method: &str,
        path: &str,
        status_code: u16,
        algorithm: &str,
        duration_secs: f64,
    ) {
        let status_str = status_code.to_string();
        let status_class = format!("{}xx", status_code / 100);
        self.requests_total
            .with_label_values(&[method, path, &status_str, algorithm])
            .inc();
        self.request_duration_seconds
            .with_label_values(&[method, &status_class])
            .observe(duration_secs);
    }

    pub fn record_backend_request(&self, backend_id: &str, algorithm: &str) {
        self.backend_requests_total
            .with_label_values(&[backend_id, algorithm])
            .inc();
    }

    pub fn record_backend_error(&self, backend_id: &str, error_kind: &str) {
        self.backend_errors_total
            .with_label_values(&[backend_id, error_kind])
            .inc();
    }

    pub fn record_backend_latency(&self, backend_id: &str, latency_secs: f64) {
        self.upstream_latency_seconds
            .with_label_values(&[backend_id])
            .observe(latency_secs);
    }

    pub fn set_backend_health(&self, backend_id: &str, healthy: bool) {
        self.backend_health_status
            .with_label_values(&[backend_id])
            .set(if healthy { 1.0 } else { 0.0 });
    }

    pub fn set_backend_connections(&self, backend_id: &str, count: f64) {
        self.backend_connections_active
            .with_label_values(&[backend_id])
            .set(count);
    }

    pub fn record_rate_limit_hit(&self, key: &str) {
        self.rate_limit_hits_total
            .with_label_values(&[key])
            .inc();
    }

    pub fn record_shard_request(&self, shard_id: u32) {
        self.shard_requests_total
            .with_label_values(&[&shard_id.to_string()])
            .inc();
    }
}
