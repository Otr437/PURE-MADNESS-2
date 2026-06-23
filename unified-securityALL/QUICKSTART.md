# Quick Start Guide

## 5-Minute Setup

### 1. Using Docker (Easiest)

```bash
# Clone repository
git clone <repo-url> && cd waf-microservice

# Start everything
docker-compose up -d

# Check it's running
curl http://localhost:8080/waf/health
```

That's it! Your WAF is now protecting traffic on port 8080.

### 2. Local Development

```bash
# Install Rust (if needed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Build and run
cargo run --release
```

### 3. Production Installation

```bash
# Run as root
sudo ./install.sh
```

## First Steps

### Test Protection

```bash
# Try a SQL injection (should be blocked)
curl "http://localhost:8080/api/test?id=1' OR '1'='1"

# Normal request (should work)
curl "http://localhost:8080/api/test?id=123"
```

### View Statistics

```bash
# Health check
curl http://localhost:8080/waf/health

# Get stats
curl http://localhost:8080/waf/stats

# See blocked IPs
curl http://localhost:8080/waf/blocked-ips

# View attack logs
curl http://localhost:8080/waf/attack-logs
```

### Add Whitelist IP

```bash
curl -X POST http://localhost:8080/waf/whitelist \
  -H "Content-Type: application/json" \
  -d '{"ip": "10.0.0.5", "reason": "Internal server"}'
```

### Configure Backend

Edit `config.toml`:

```toml
[[backends]]
name = "myapp"
url = "http://localhost:3000"
path_prefix = "/"
```

Restart the WAF:
```bash
docker-compose restart waf
# OR
systemctl restart waf
```

## Monitoring

### Prometheus Metrics
```bash
curl http://localhost:8080/waf/metrics
```

### Grafana Dashboard
1. Open http://localhost:3001
2. Login: admin/admin
3. Import dashboard from `grafana/dashboards/waf-dashboard.json`

## Testing

Run the comprehensive test suite:

```bash
./test_waf.sh
```

Expected output:
```
🛡️  WAF Protection Test Suite
================================
Test 1: Basic SQL injection... ✓ BLOCKED
Test 2: UNION SELECT attack... ✓ BLOCKED
Test 3: Script tag injection... ✓ BLOCKED
...
🎉 All tests passed!
```

## Common Issues

### Port Already in Use
```bash
# Change port in config.toml
port = 8081
```

### Database Locked
```bash
# Stop all WAF instances
docker-compose down
# OR
systemctl stop waf

# Restart
docker-compose up -d
```

### High False Positives
```bash
# Whitelist your IP
curl -X POST http://localhost:8080/waf/whitelist \
  -H "Content-Type: application/json" \
  -d '{"ip": "YOUR_IP", "reason": "Development machine"}'
```

## Next Steps

1. **Configure Backends**: Add your services to `config.toml`
2. **Tune Rate Limits**: Adjust `rate_limit_requests` and `rate_limit_window`
3. **Add Custom Rules**: POST to `/waf/rules` endpoint
4. **Set Up Monitoring**: Configure Prometheus + Grafana
5. **Review Logs**: Check `/waf/attack-logs` regularly

## Production Checklist

- [ ] Run behind NGINX/load balancer
- [ ] Enable HTTPS
- [ ] Configure proper rate limits
- [ ] Set up log rotation
- [ ] Configure backup for SQLite database
- [ ] Set up alerting (Prometheus Alertmanager)
- [ ] Whitelist monitoring IPs
- [ ] Test with production-like traffic
- [ ] Document custom rules
- [ ] Set up log aggregation (ELK, Loki, etc.)

## Get Help

- Read the full README.md
- Check API_DOCS.md for endpoint details
- Review example configs in `examples/`
- Open an issue on GitHub

## Advanced

### Kubernetes Deployment
```bash
kubectl apply -f k8s/
```

### High Availability Setup
```bash
# Deploy multiple instances behind load balancer
docker-compose up -d --scale waf=3
```

### Custom Attack Patterns
See `src/attacks.rs` to add new detection patterns.

---

**You're all set!** Your applications are now protected by a production-grade WAF. 🛡️
