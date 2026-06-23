// Command Injection detection
const CMD_INJECTION_PATTERNS = [
  /[;&|`$(){}]/g,
  /(;|\||&&|\|\||`|\$\(|\${)/g,
  /\b(nc|netcat|ncat)\s/gi,
  /\b(curl|wget)\s/gi,
  /\b(bash|sh|zsh|ksh|csh)\s/gi,
  /\b(python|perl|ruby|php)\s/gi,
  /\b(cat|more|less|head|tail)\s/gi,
  /\b(chmod|chown|chgrp)\s/gi,
  /\b(rm|mv|cp)\s/gi,
  /\b(whoami|id|uname)\s/gi,
  /\b(ifconfig|ipconfig|netstat)\s/gi,
  /\b(ps|top|kill|killall)\s/gi,
  /\b(find|locate|which)\s/gi,
  /(\/dev\/tcp\/)/gi,
  /(\/dev\/udp\/)/gi,
  /\b(exec|eval|system|passthru|shell_exec|popen|proc_open)\b/gi
];

export function detectCommandInjection(query, body) {
  const combined = `${query} ${body}`;
  
  for (const pattern of CMD_INJECTION_PATTERNS) {
    const match = combined.match(pattern);
    if (match) {
      return {
        payload: match[0].substring(0, 100),
        details: `Command injection pattern detected: ${match[0].substring(0, 50)}`
      };
    }
  }
  
  return null;
}
