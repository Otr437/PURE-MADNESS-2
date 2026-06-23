// XXE (XML External Entity) detection
const XXE_PATTERNS = [
  /<!ENTITY/gi,
  /<!DOCTYPE/gi,
  /SYSTEM\s+['"]/gi,
  /PUBLIC\s+['"]/gi,
  /file:\/\//gi,
  /expect:\/\//gi,
  /php:\/\/filter/gi,
  /php:\/\/input/gi,
  /data:\/\//gi
];

export function detectXxe(body) {
  if (!body || typeof body !== 'string') return null;
  
  for (const pattern of XXE_PATTERNS) {
    const match = body.match(pattern);
    if (match) {
      return {
        payload: match[0],
        details: `XXE pattern detected: ${match[0]}`
      };
    }
  }
  
  return null;
}

// SSRF (Server-Side Request Forgery) detection  
const SSRF_PATTERNS = [
  /(http:\/\/|https:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|0000::1)/gi,
  /(http:\/\/|https:\/\/)192\.168\.\d+\.\d+/gi,
  /(http:\/\/|https:\/\/)10\.\d+\.\d+\.\d+/gi,
  /(http:\/\/|https:\/\/)172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/gi,
  /file:\/\//gi,
  /dict:\/\//gi,
  /gopher:\/\//gi,
  /ldap:\/\//gi,
  /tftp:\/\//gi,
  // AWS metadata
  /169\.254\.169\.254/g,
  // GCP metadata
  /metadata\.google\.internal/g,
  // Azure metadata
  /169\.254\.169\.254/g
];

export function detectSsrf(query, body) {
  const combined = `${query} ${body}`;
  
  for (const pattern of SSRF_PATTERNS) {
    const match = combined.match(pattern);
    if (match) {
      return {
        payload: match[0].substring(0, 100),
        details: `SSRF pattern detected: ${match[0].substring(0, 50)}`
      };
    }
  }
  
  return null;
}
