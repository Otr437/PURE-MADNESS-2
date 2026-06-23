// Path Traversal detection
const PATH_TRAVERSAL_PATTERNS = [
  /(\.\.|\.\.\/|\.\.\\)/g,
  /(\.\.%2f|\.\.%2F)/gi,
  /(\.\.%5c|\.\.%5C)/gi,
  /(%2e%2e%2f|%2e%2e\/)/gi,
  /(\.%2e%2f|\.%2e\/)/gi,
  /(%2e\.%2f|%2e\.\/)/gi,
  /(\/etc\/passwd|\/etc\/shadow)/gi,
  /(c:\\windows|c:\\winnt)/gi,
  /(\/proc\/self\/)/gi,
  /(\/var\/log\/)/gi,
  /\x00/g // NULL byte
];

export function detectPathTraversal(path, query) {
  const combined = `${path} ${query}`;
  
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    const match = combined.match(pattern);
    if (match) {
      return {
        payload: match[0],
        details: `Path traversal pattern detected: ${match[0]}`
      };
    }
  }
  
  return null;
}
