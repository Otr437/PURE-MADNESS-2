// XSS detection patterns
const XSS_PATTERNS = [
  // Script tags
  /<script[^>]*>.*?<\/script>/gi,
  /<script[^>]*>/gi,
  
  // Event handlers
  /on\w+\s*=/gi,
  /onerror\s*=/gi,
  /onload\s*=/gi,
  /onclick\s*=/gi,
  /onmouseover\s*=/gi,
  /onfocus\s*=/gi,
  /onblur\s*=/gi,
  /onchange\s*=/gi,
  /onsubmit\s*=/gi,
  
  // Dangerous tags
  /<iframe[^>]*>/gi,
  /<object[^>]*>/gi,
  /<embed[^>]*>/gi,
  /<applet[^>]*>/gi,
  /<frame[^>]*>/gi,
  /<frameset[^>]*>/gi,
  
  // JavaScript protocol
  /javascript:/gi,
  /vbscript:/gi,
  /data:text\/html/gi,
  
  // Image-based XSS
  /<img[^>]+src[^>]*>/gi,
  /<img[^>]+onerror[^>]*>/gi,
  
  // SVG-based XSS
  /<svg[^>]*onload/gi,
  /<svg[^>]*>/gi,
  
  // Body events
  /<body[^>]*onload/gi,
  
  // Form events
  /<input[^>]*onfocus/gi,
  /<select[^>]*onfocus/gi,
  /<textarea[^>]*onfocus/gi,
  /<keygen[^>]*onfocus/gi,
  
  // Media events
  /<video[^>]*onerror/gi,
  /<audio[^>]*onerror/gi,
  
  // Comments
  /<!--.*?-->/gi,
  
  // Meta refresh
  /<meta[^>]*http-equiv/gi,
  
  // CSS expression
  /expression\s*\(/gi,
  
  // Import
  /@import/gi,
  /import\s+/gi,
  
  // Link stylesheet
  /<link[^>]*stylesheet/gi,
  /<style[^>]*>/gi,
  
  // Base64 encoded scripts
  /base64,[\w+/=]+/gi,
  
  // Encoded characters
  /&#x?[0-9a-f]+;/gi,
  
  // Unicode encoded
  /\\u[0-9a-f]{4}/gi,
  
  // Common XSS vectors
  /<\s*script/gi,
  /\bonload\s*=/gi,
  /\bonerror\s*=/gi,
  /javascript\s*:/gi,
  /<\s*iframe/gi,
  
  // Less common vectors
  /<details[^>]*open/gi,
  /<marquee[^>]*onstart/gi,
  /<isindex[^>]*/gi
];

export function detectXss(query, body, headers) {
  const combined = `${query} ${body}`;
  
  // Check query and body
  for (const pattern of XSS_PATTERNS) {
    const match = combined.match(pattern);
    if (match) {
      return {
        payload: match[0].substring(0, 100),
        details: `XSS pattern detected: ${match[0].substring(0, 50)}`
      };
    }
  }
  
  // Check headers
  const suspiciousHeaders = ['referer', 'user-agent', 'x-forwarded-for', 'cookie'];
  for (const headerName of suspiciousHeaders) {
    const headerValue = headers[headerName];
    if (headerValue) {
      for (const pattern of XSS_PATTERNS) {
        const match = headerValue.match(pattern);
        if (match) {
          return {
            payload: `${headerName}: ${match[0].substring(0, 100)}`,
            details: `XSS in header ${headerName}: ${match[0].substring(0, 50)}`
          };
        }
      }
    }
  }
  
  return null;
}
