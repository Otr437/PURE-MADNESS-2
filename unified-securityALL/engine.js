import { getRules } from '../database.js';

// Default rules loaded at startup
const defaultRules = [
  {
    id: 'block_admin_path',
    name: 'Block Admin Path Access',
    description: 'Block unauthorized access to /admin paths',
    enabled: true,
    action: 'block',
    conditions: [
      {
        field: 'path',
        operator: 'starts_with',
        value: '/admin',
        caseSensitive: false
      }
    ],
    banDuration: 300
  },
  {
    id: 'block_dot_env',
    name: 'Block .env File Access',
    description: 'Prevent access to environment files',
    enabled: true,
    action: 'block',
    conditions: [
      {
        field: 'path',
        operator: 'contains',
        value: '.env',
        caseSensitive: false
      }
    ],
    banDuration: 3600
  },
  {
    id: 'block_git_directory',
    name: 'Block .git Directory',
    description: 'Prevent access to git directories',
    enabled: true,
    action: 'block',
    conditions: [
      {
        field: 'path',
        operator: 'contains',
        value: '.git/',
        caseSensitive: false
      }
    ],
    banDuration: 3600
  }
];

export async function checkRules(method, path, headers, body, ip) {
  const rules = getRules();
  
  // If no custom rules, use defaults
  const allRules = rules.length > 0 ? rules : defaultRules;
  
  for (const rule of allRules) {
    if (!rule.enabled) continue;
    
    const allConditionsMet = rule.conditions.every(condition => 
      checkCondition(condition, method, path, headers, body, ip)
    );
    
    if (allConditionsMet) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        action: rule.action,
        banDuration: rule.banDuration
      };
    }
  }
  
  return null;
}

function checkCondition(condition, method, path, headers, body, ip) {
  let fieldValue;
  
  // Get field value
  switch (condition.field) {
    case 'method':
      fieldValue = method;
      break;
    case 'path':
      fieldValue = path;
      break;
    case 'query':
      const url = new URL(path, 'http://localhost');
      fieldValue = url.search;
      break;
    case 'body':
      fieldValue = body;
      break;
    case 'ip':
      fieldValue = ip;
      break;
    case 'user_agent':
      fieldValue = headers['user-agent'] || '';
      break;
    default:
      // Custom header
      if (condition.field.startsWith('header:')) {
        const headerName = condition.field.substring(7);
        fieldValue = headers[headerName] || '';
      } else {
        return false;
      }
  }
  
  // Apply case sensitivity
  if (!condition.caseSensitive) {
    fieldValue = fieldValue.toLowerCase();
    condition.value = condition.value.toLowerCase();
  }
  
  // Check operator
  switch (condition.operator) {
    case 'equals':
      return fieldValue === condition.value;
    case 'not_equals':
      return fieldValue !== condition.value;
    case 'contains':
      return fieldValue.includes(condition.value);
    case 'not_contains':
      return !fieldValue.includes(condition.value);
    case 'starts_with':
      return fieldValue.startsWith(condition.value);
    case 'ends_with':
      return fieldValue.endsWith(condition.value);
    case 'regex':
      try {
        const regex = new RegExp(condition.value, condition.caseSensitive ? '' : 'i');
        return regex.test(fieldValue);
      } catch (err) {
        return false;
      }
    case 'length_greater':
      return fieldValue.length > parseInt(condition.value, 10);
    case 'length_less':
      return fieldValue.length < parseInt(condition.value, 10);
    default:
      return false;
  }
}
