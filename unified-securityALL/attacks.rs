use lazy_static::lazy_static;
use regex::Regex;
use axum::http::HeaderMap;

#[derive(Debug, Clone)]
pub struct AttackDetection {
    pub payload: String,
    pub details: String,
}

lazy_static! {
    // SQL Injection patterns
    static ref SQL_PATTERNS: Vec<Regex> = vec![
        Regex::new(r"(?i)(union\s+select|union\s+all\s+select)").unwrap(),
        Regex::new(r"(?i)(select\s+.+\s+from\s+)").unwrap(),
        Regex::new(r"(?i)(insert\s+into\s+.+\s+values)").unwrap(),
        Regex::new(r"(?i)(delete\s+from\s+)").unwrap(),
        Regex::new(r"(?i)(update\s+.+\s+set\s+)").unwrap(),
        Regex::new(r"(?i)(drop\s+(table|database))").unwrap(),
        Regex::new(r"(?i)(create\s+(table|database))").unwrap(),
        Regex::new(r"(?i)(alter\s+table)").unwrap(),
        Regex::new(r"(?i)(exec(\s|\()|execute(\s|\())").unwrap(),
        Regex::new(r"(?i)(script|javascript|<script|onerror|onload)").unwrap(),
        Regex::new(r"(\'|\"|;|--|\*|\/\*|\*\/|@@|@|char|nchar|varchar|nvarchar|alter|begin|cast|create|cursor|declare|drop|end|exec|execute|fetch|insert|kill|select|sys|sysobjects|syscolumns|table|update)").unwrap(),
        Regex::new(r"(\%27)|(\')|(--)|(\%23)|(#)").unwrap(),
        Regex::new(r"((\%3D)|(=))[^\n]*((\%27)|(\')|(\-\-)|(\%3B)|(;))").unwrap(),
        Regex::new(r"(?i)((\%27)|(\'))\s*((\%6F)|o|(\%4F))((\%72)|r|(\%52))").unwrap(),
        Regex::new(r"(?i)\w*((\%27)|(\'))((\%6F)|o|(\%4F))((\%72)|r|(\%52))").unwrap(),
        Regex::new(r"(?i)((\%27)|(\'))union").unwrap(),
        Regex::new(r"(?i)((\%27)|(\'))(\s)*(or|and)(\s)*((\%27)|(\'))").unwrap(),
        Regex::new(r"(?i)0x[0-9a-f]+").unwrap(),
        Regex::new(r"(?i)(benchmark|sleep|waitfor)\s*\(").unwrap(),
    ];

    // XSS patterns
    static ref XSS_PATTERNS: Vec<Regex> = vec![
        Regex::new(r"(?i)<script[^>]*>.*?</script>").unwrap(),
        Regex::new(r"(?i)<iframe[^>]*>").unwrap(),
        Regex::new(r"(?i)<object[^>]*>").unwrap(),
        Regex::new(r"(?i)<embed[^>]*>").unwrap(),
        Regex::new(r"(?i)<applet[^>]*>").unwrap(),
        Regex::new(r"(?i)on\w+\s*=").unwrap(), // onerror, onload, etc.
        Regex::new(r"(?i)javascript:").unwrap(),
        Regex::new(r"(?i)vbscript:").unwrap(),
        Regex::new(r"(?i)data:text/html").unwrap(),
        Regex::new(r"(?i)<img[^>]+src[^>]*>").unwrap(),
        Regex::new(r"(?i)<svg[^>]*onload").unwrap(),
        Regex::new(r"(?i)<body[^>]*onload").unwrap(),
        Regex::new(r"(?i)<input[^>]*onfocus").unwrap(),
        Regex::new(r"(?i)<select[^>]*onfocus").unwrap(),
        Regex::new(r"(?i)<textarea[^>]*onfocus").unwrap(),
        Regex::new(r"(?i)<keygen[^>]*onfocus").unwrap(),
        Regex::new(r"(?i)<video[^>]*onerror").unwrap(),
        Regex::new(r"(?i)<audio[^>]*onerror").unwrap(),
        Regex::new(r"(?i)<!--.*?-->").unwrap(),
        Regex::new(r"(?i)<meta[^>]*http-equiv").unwrap(),
        Regex::new(r"(?i)expression\s*\(").unwrap(),
        Regex::new(r"(?i)import\s+").unwrap(),
        Regex::new(r"(?i)@import").unwrap(),
        Regex::new(r"(?i)<link[^>]*stylesheet").unwrap(),
        Regex::new(r"(?i)<style[^>]*>").unwrap(),
        Regex::new(r"(?i)src\s*=\s*['\"]?javascript:").unwrap(),
    ];

    // Path Traversal patterns
    static ref PATH_TRAVERSAL_PATTERNS: Vec<Regex> = vec![
        Regex::new(r"(\.\./|\.\.//)").unwrap(),
        Regex::new(r"(\.\.\%2f|\.\.\%2F)").unwrap(),
        Regex::new(r"(\.\.\\|\.\.\\\\)").unwrap(),
        Regex::new(r"(\.\.\%5c|\.\.\%5C)").unwrap(),
        Regex::new(r"(%2e%2e%2f|%2e%2e/)").unwrap(),
        Regex::new(r"(\.%2e%2f|\.%2e/)").unwrap(),
        Regex::new(r"(%2e\.%2f|%2e\./)").unwrap(),
        Regex::new(r"(?i)(\/etc\/passwd|\/etc\/shadow)").unwrap(),
        Regex::new(r"(?i)(c:\\windows|c:\\winnt)").unwrap(),
        Regex::new(r"(?i)(\/proc\/self\/)").unwrap(),
        Regex::new(r"(?i)(\/var\/log\/)").unwrap(),
        Regex::new(r"(\x00)").unwrap(), // NULL byte
    ];

    // Command Injection patterns
    static ref CMD_INJECTION_PATTERNS: Vec<Regex> = vec![
        Regex::new(r"[;&|`$(){}]").unwrap(),
        Regex::new(r"(?i)(;|\||&&|\|\||`|\$\(|\${)").unwrap(),
        Regex::new(r"(?i)(nc|netcat|ncat)\s").unwrap(),
        Regex::new(r"(?i)(curl|wget)\s").unwrap(),
        Regex::new(r"(?i)(bash|sh|zsh|ksh|csh)\s").unwrap(),
        Regex::new(r"(?i)(python|perl|ruby|php)\s").unwrap(),
        Regex::new(r"(?i)(cat|more|less|head|tail)\s").unwrap(),
        Regex::new(r"(?i)(chmod|chown|chgrp)\s").unwrap(),
        Regex::new(r"(?i)(rm|mv|cp)\s").unwrap(),
        Regex::new(r"(?i)(whoami|id|uname)\s").unwrap(),
        Regex::new(r"(?i)(ifconfig|ipconfig|netstat)\s").unwrap(),
        Regex::new(r"(?i)(ps|top|kill|killall)\s").unwrap(),
        Regex::new(r"(?i)(find|locate|which)\s").unwrap(),
        Regex::new(r"(?i)(/dev/tcp/)").unwrap(),
        Regex::new(r"(?i)(/dev/udp/)").unwrap(),
        Regex::new(r"(?i)(exec|eval|system|passthru|shell_exec|popen|proc_open)").unwrap(),
    ];

    // XXE (XML External Entity) patterns
    static ref XXE_PATTERNS: Vec<Regex> = vec![
        Regex::new(r"(?i)<!ENTITY").unwrap(),
        Regex::new(r"(?i)<!DOCTYPE").unwrap(),
        Regex::new(r"(?i)SYSTEM\s+['\"]").unwrap(),
        Regex::new(r"(?i)PUBLIC\s+['\"]").unwrap(),
        Regex::new(r"(?i)file://").unwrap(),
        Regex::new(r"(?i)expect://").unwrap(),
        Regex::new(r"(?i)php://filter").unwrap(),
        Regex::new(r"(?i)php://input").unwrap(),
        Regex::new(r"(?i)data://").unwrap(),
    ];

    // SSRF patterns
    static ref SSRF_PATTERNS: Vec<Regex> = vec![
        Regex::new(r"(?i)(http://|https://)(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|0000::1)").unwrap(),
        Regex::new(r"(?i)(http://|https://)192\.168\.\d+\.\d+").unwrap(),
        Regex::new(r"(?i)(http://|https://)10\.\d+\.\d+\.\d+").unwrap(),
        Regex::new(r"(?i)(http://|https://)172\.(1[6-9]|2\d|3[01])\.\d+\.\d+").unwrap(),
        Regex::new(r"(?i)file://").unwrap(),
        Regex::new(r"(?i)dict://").unwrap(),
        Regex::new(r"(?i)gopher://").unwrap(),
        Regex::new(r"(?i)ldap://").unwrap(),
        Regex::new(r"(?i)tftp://").unwrap(),
    ];
}

pub fn detect_sql_injection(query: &str, body: &str) -> Option<AttackDetection> {
    let combined = format!("{} {}", query, body).to_lowercase();
    
    for pattern in SQL_PATTERNS.iter() {
        if let Some(mat) = pattern.find(&combined) {
            return Some(AttackDetection {
                payload: mat.as_str().to_string(),
                details: format!("SQL injection pattern detected: {}", mat.as_str()),
            });
        }
    }
    None
}

pub fn detect_xss(query: &str, body: &str, headers: &HeaderMap) -> Option<AttackDetection> {
    let combined = format!("{} {}", query, body);
    
    // Check URL and body
    for pattern in XSS_PATTERNS.iter() {
        if let Some(mat) = pattern.find(&combined) {
            return Some(AttackDetection {
                payload: mat.as_str().to_string(),
                details: format!("XSS pattern detected: {}", mat.as_str()),
            });
        }
    }
    
    // Check headers
    for (name, value) in headers.iter() {
        if let Ok(val_str) = value.to_str() {
            for pattern in XSS_PATTERNS.iter() {
                if pattern.is_match(val_str) {
                    return Some(AttackDetection {
                        payload: format!("{}: {}", name, val_str),
                        details: format!("XSS in header: {}", name),
                    });
                }
            }
        }
    }
    
    None
}

pub fn detect_path_traversal(path: &str, query: &str) -> Option<AttackDetection> {
    let combined = format!("{} {}", path, query);
    
    for pattern in PATH_TRAVERSAL_PATTERNS.iter() {
        if let Some(mat) = pattern.find(&combined) {
            return Some(AttackDetection {
                payload: mat.as_str().to_string(),
                details: format!("Path traversal pattern detected: {}", mat.as_str()),
            });
        }
    }
    None
}

pub fn detect_command_injection(query: &str, body: &str) -> Option<AttackDetection> {
    let combined = format!("{} {}", query, body);
    
    for pattern in CMD_INJECTION_PATTERNS.iter() {
        if let Some(mat) = pattern.find(&combined) {
            return Some(AttackDetection {
                payload: mat.as_str().to_string(),
                details: format!("Command injection pattern detected: {}", mat.as_str()),
            });
        }
    }
    None
}

pub fn detect_xxe(body: &str) -> Option<AttackDetection> {
    for pattern in XXE_PATTERNS.iter() {
        if let Some(mat) = pattern.find(body) {
            return Some(AttackDetection {
                payload: mat.as_str().to_string(),
                details: format!("XXE pattern detected: {}", mat.as_str()),
            });
        }
    }
    None
}

pub fn detect_ssrf(query: &str, body: &str) -> Option<AttackDetection> {
    let combined = format!("{} {}", query, body);
    
    for pattern in SSRF_PATTERNS.iter() {
        if let Some(mat) = pattern.find(&combined) {
            return Some(AttackDetection {
                payload: mat.as_str().to_string(),
                details: format!("SSRF pattern detected: {}", mat.as_str()),
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sql_injection_detection() {
        assert!(detect_sql_injection("id=1' OR '1'='1", "").is_some());
        assert!(detect_sql_injection("", "username=admin' UNION SELECT * FROM users--").is_some());
        assert!(detect_sql_injection("safe_param=123", "name=John").is_none());
    }

    #[test]
    fn test_xss_detection() {
        let headers = HeaderMap::new();
        assert!(detect_xss("", "<script>alert('xss')</script>", &headers).is_some());
        assert!(detect_xss("", "<img src=x onerror=alert(1)>", &headers).is_some());
        assert!(detect_xss("", "safe content", &headers).is_none());
    }

    #[test]
    fn test_path_traversal_detection() {
        assert!(detect_path_traversal("../../etc/passwd", "").is_some());
        assert!(detect_path_traversal("/api/file", "path=..%2F..%2Fetc%2Fpasswd").is_some());
        assert!(detect_path_traversal("/api/safe", "param=value").is_none());
    }

    #[test]
    fn test_command_injection_detection() {
        assert!(detect_command_injection("", "cmd=ls; cat /etc/passwd").is_some());
        assert!(detect_command_injection("", "input=$(whoami)").is_some());
        assert!(detect_command_injection("", "safe_command").is_none());
    }
}
