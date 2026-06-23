// SQL Injection detection patterns
const SQL_PATTERNS = [
  // Union-based attacks
  /(\bunion\b.*\bselect\b)/gi,
  /(\bunion\b.*\ball\b.*\bselect\b)/gi,
  
  // Basic SQL commands
  /(\bselect\b.*\bfrom\b)/gi,
  /(\binsert\b.*\binto\b)/gi,
  /(\bupdate\b.*\bset\b)/gi,
  /(\bdelete\b.*\bfrom\b)/gi,
  /(\bdrop\b.*\b(table|database)\b)/gi,
  /(\bcreate\b.*\b(table|database)\b)/gi,
  /(\balter\b.*\btable\b)/gi,
  
  // Execution commands
  /(exec(\s|\()|execute(\s|\())/gi,
  
  // Common SQL keywords in suspicious contexts
  /(\bor\b.*\b1\s*=\s*1)/gi,
  /(\band\b.*\b1\s*=\s*1)/gi,
  /(\'|\"|;|--|\/\*|\*\/|@@|@)/g,
  
  // Encoded attacks
  /(%27)|(\')|(--)|(%23)|(#)/gi,
  /((\%3D)|(=))[^\n]*((\%27)|(\')|(\-\-)|(\%3B)|(;))/gi,
  /((\%27)|(\'))\s*((\%6F)|o|(\%4F))((\%72)|r|(\%52))/gi,
  /\w*((\%27)|(\'))((\%6F)|o|(\%4F))((\%72)|r|(\%52))/gi,
  
  // Boolean-based blind
  /((\%27)|(\'))union/gi,
  /((\%27)|(\'))(\s)*(or|and)(\s)*((\%27)|(\'))/gi,
  
  // Hex-encoded
  /0x[0-9a-f]+/gi,
  
  // Time-based blind
  /\b(benchmark|sleep|waitfor)\s*\(/gi,
  
  // Comment-based
  /(\/\*.*\*\/|--[^\n]*|#[^\n]*)/gi,
  
  // MSSQL specific
  /\b(xp_cmdshell|sp_executesql)\b/gi,
  
  // MySQL specific  
  /\b(load_file|into\s+outfile|into\s+dumpfile)\b/gi,
  
  // PostgreSQL specific
  /\b(pg_sleep|copy\s+from)\b/gi,
  
  // Oracle specific
  /\b(dbms_pipe|dbms_utility)\b/gi,
  
  // Information gathering
  /\b(information_schema|sysobjects|syscolumns)\b/gi
];

export function detectSqlInjection(query, body) {
  const combined = `${query} ${body}`.toLowerCase();
  
  for (const pattern of SQL_PATTERNS) {
    const match = combined.match(pattern);
    if (match) {
      return {
        payload: match[0].substring(0, 100),
        details: `SQL injection pattern detected: ${match[0].substring(0, 50)}`
      };
    }
  }
  
  return null;
}
