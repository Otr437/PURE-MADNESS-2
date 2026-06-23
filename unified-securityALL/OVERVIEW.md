# WAF Microservice - Project Overview

## What Is This?

A **production-ready Web Application Firewall (WAF)** built in Rust that protects your web applications from common attacks. Think of it as a security guard that sits in front of your web services and blocks malicious traffic before it reaches them.

## Why Rust in 2026?

Based on industry trends, Rust is the go-to language for high-performance security infrastructure:
- **Memory Safety**: Zero buffer overflows or memory corruption
- **Performance**: Near C/C++ speeds with modern ergonomics  
- **Concurrency**: Built-in async/await for handling thousands of connections
- **Used by Leaders**: Cloudflare, AWS, Microsoft use Rust for security-critical services

Cloudflare's WAF, which blocks 57+ billion threats per day, is built with Rust and their Wirefilter engine.

## What Does It Protect Against?

### OWASP Top 10 Coverage

✅ **A03:2021 - Injection**
- SQL Injection (20+ patterns)
- Command Injection
- LDAP Injection
- NoSQL Injection

✅ **A07:2021 - XSS (Cross-Site Scripting)**
- Reflected XSS
- Stored XSS
- DOM-based XSS
- Event handler injection
- 25+ XSS patterns

✅ **A01:2021 - Broken Access Control**
- Path traversal attacks
- Directory listing
- File inclusion (LFI/RFI)
- Unauthorized admin access

✅ **A10:2021 - SSRF (Server-Side Request Forgery)**
- Internal network access attempts
- Cloud metadata endpoints
- Localhost bypass attempts

✅ **A05:2021 - Security Misconfiguration**
- Exposed sensitive files (.env, .git)
- Debug endpoints
- Default credentials

✅ **A04:2021 - Insecure Design**
- Brute force protection
- Rate limiting
- Input validation

### Additional Protections

- **XXE (XML External Entity)**: Blocks malicious XML parsing
- **Bot Detection**: Identifies and blocks malicious bots
- **Rate Limiting**: Per-IP request throttling
- **Request Size Limits**: Prevents DoS via large payloads
- **Custom Rules Engine**: Create your own detection rules

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Internet                       │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│              Load Balancer / NGINX               │
│           (Optional - Recommended)               │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│           WAF Microservice (Rust)                │
│  ┌───────────────────────────────────────────┐  │
│  │         Axum Web Framework                │  │
│  │           (Async Tokio)                   │  │
│  └───────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────┐  │
│  │      WAF Middleware (Layer)               │  │
│  │  • IP Whitelist Check                     │  │
│  │  • IP Blacklist Check                     │  │
│  │  • Rate Limiting                          │  │
│  │  • Request Size Validation                │  │
│  │  • SQL Injection Detection                │  │
│  │  • XSS Detection                          │  │
│  │  • Path Traversal Detection               │  │
│  │  • Command Injection Detection            │  │
│  │  • Custom Rules Engine                    │  │
│  └───────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────┐  │
│  │        Storage Layer                      │  │
│  │  • SQLite (Attack Logs, Blocks)           │  │
│  │  • In-Memory (Rate Limits, Cache)         │  │
│  └───────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────┐  │
│  │         Metrics & Logging                 │  │
│  │  • Prometheus Metrics                     │  │
│  │  • JSON Structured Logs                   │  │
│  └───────────────────────────────────────────┘  │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│           Backend Services                       │
│  • API Servers                                   │
│  • Web Applications                              │
│  • Microservices                                 │
└─────────────────────────────────────────────────┘
```

## Components

### 1. Core WAF Engine (`src/main.rs`)
- Request interception
- Middleware orchestration
- Backend proxying
- Admin API endpoints

### 2. Attack Detection (`src/attacks.rs`)
- Pattern matching with Regex
- 60+ attack signatures
- Lazy-loaded for performance
- Tested and verified patterns

### 3. Rate Limiter (`src/rate_limit.rs`)
- Token bucket algorithm
- Per-IP tracking
- Configurable limits
- Automatic cleanup

### 4. Rules Engine (`src/rules.rs`)
- Custom rule creation
- Multiple condition support
- Regex capabilities
- Hot reload without restart

### 5. Metrics System (`src/metrics.rs`)
- Prometheus integration
- Request counters
- Attack type tracking
- Response time histograms

### 6. Configuration (`src/config.rs`)
- TOML-based config
- Runtime configuration
- Backend service definitions
- Feature toggles

## Performance Characteristics

### Benchmarks (Expected)

- **Throughput**: 15,000+ req/sec per core
- **Latency**: <1ms overhead for clean requests
- **Latency (inspection)**: 2-7ms for full inspection
- **Memory**: ~50MB base + ~10KB per tracked IP
- **CPU**: ~30% for 10K req/sec on 4-core system

### Scalability

**Vertical Scaling:**
- Linear scaling with cores
- 4 cores → 60K req/sec
- 8 cores → 120K req/sec

**Horizontal Scaling:**
- Stateless design (except IP blocks)
- Load balance across multiple instances
- Shared database for block list sync

## Deployment Options

### 1. Docker (Recommended for Development)
```bash
docker-compose up -d
```
- WAF service
- Prometheus
- Grafana
- Complete monitoring stack

### 2. Kubernetes (Recommended for Production)
```yaml
replicas: 3  # High availability
resources:
  requests:
    cpu: "500m"
    memory: "256Mi"
  limits:
    cpu: "2000m"
    memory: "1Gi"
```

### 3. Systemd Service (Linux Servers)
```bash
sudo ./install.sh
systemctl status waf
```

### 4. Behind NGINX
```nginx
upstream waf {
    server 127.0.0.1:8080;
}
location / {
    proxy_pass http://waf;
}
```

## Configuration Examples

### Basic Protection
```toml
port = 8080
rate_limit_requests = 100
rate_limit_window = 60
max_request_size = 10485760
```

### Strict Mode
```toml
rate_limit_requests = 50
rate_limit_window = 60
attack_ban_duration = 7200
max_request_size = 5242880
```

### Development Mode
```toml
enable_rate_limiting = false
rate_limit_requests = 10000
attack_ban_duration = 60
```

## Monitoring Stack

### Prometheus
- Scrapes `/waf/metrics` every 5s
- Stores time-series data
- Configurable retention

### Grafana
- Pre-built dashboards
- Real-time visualization
- Alerting capabilities

### Logs
- JSON structured logging
- Attack attempt details
- Response time tracking
- Error categorization

## Security Considerations

### What This WAF Does
✅ Blocks known attack patterns
✅ Rate limits abusive clients
✅ Logs all attack attempts
✅ Provides detailed metrics
✅ Supports custom rules

### What This WAF Doesn't Do
❌ Replace proper authentication
❌ Encrypt traffic (use HTTPS)
❌ Prevent all zero-days
❌ Replace application security
❌ Guarantee 100% protection

### Defense in Depth
This WAF is **one layer** of security. Also implement:
- Input validation in application
- Output encoding
- Parameterized queries
- Least privilege access
- Regular security audits
- Dependency scanning
- Code reviews

## Comparison with Other WAFs

| Feature | This WAF | ModSecurity | Cloudflare | AWS WAF |
|---------|----------|-------------|------------|---------|
| Language | Rust | C | Rust | - |
| Self-Hosted | ✅ | ✅ | ❌ | ❌ |
| Open Source | ✅ | ✅ | Partial | ❌ |
| Custom Rules | ✅ | ✅ | ✅ ($$) | ✅ ($$) |
| Performance | High | Medium | Very High | High |
| Ease of Use | Easy | Hard | Easy | Medium |
| Cost | Free | Free | $$$ | $$ |

## Use Cases

### 1. API Gateway Protection
Protect RESTful APIs from injection attacks and abuse.

### 2. Legacy Application Shield
Add security to applications that can't be easily modified.

### 3. Microservices Security
Deploy as sidecar container in Kubernetes.

### 4. Development Environment
Catch security issues during development.

### 5. Compliance Requirements
Meet PCI DSS, HIPAA, SOC 2 requirements.

## Roadmap

### v1.0 (Current)
- ✅ Core attack detection
- ✅ Rate limiting
- ✅ Custom rules
- ✅ Metrics/logging

### v1.1 (Planned)
- [ ] GeoIP blocking
- [ ] Machine learning detection
- [ ] Redis support for clustering
- [ ] GraphQL protection

### v2.0 (Future)
- [ ] WASM plugin system
- [ ] API for managed rules
- [ ] Automated rule tuning
- [ ] Advanced bot detection

## Contributing

Areas where contributions are welcome:
1. Additional attack patterns
2. Performance optimizations
3. Documentation improvements
4. Integration examples
5. Test coverage
6. Bug fixes

## License

Apache 2.0 - Free for commercial use

## Credits

- Built with Axum web framework
- Inspired by Cloudflare's Wirefilter
- Attack patterns from OWASP
- Testing methodology from ModSecurity

---

**Need help?** Check the docs:
- README.md - Full documentation
- QUICKSTART.md - Get started in 5 minutes  
- API_DOCS.md - Complete API reference
- examples/ - Configuration examples
