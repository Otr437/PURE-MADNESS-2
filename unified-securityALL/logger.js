import { logAttackToDb } from '../database.js';

// Simple colored console logger
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

class Logger {
  constructor() {
    this.isDevelopment = process.env.NODE_ENV !== 'production';
  }
  
  formatTimestamp() {
    return new Date().toISOString();
  }
  
  info(...args) {
    console.log(`${colors.blue}[INFO]${colors.reset}`, this.formatTimestamp(), ...args);
  }
  
  warn(...args) {
    console.log(`${colors.yellow}[WARN]${colors.reset}`, this.formatTimestamp(), ...args);
  }
  
  error(...args) {
    console.log(`${colors.red}[ERROR]${colors.reset}`, this.formatTimestamp(), ...args);
  }
  
  success(...args) {
    console.log(`${colors.green}[SUCCESS]${colors.reset}`, this.formatTimestamp(), ...args);
  }
  
  debug(...args) {
    if (this.isDevelopment) {
      console.log(`${colors.cyan}[DEBUG]${colors.reset}`, this.formatTimestamp(), ...args);
    }
  }
}

export const logger = new Logger();

export function logAttack(attack) {
  logger.warn(
    `🚨 Attack detected: ${attack.attackType} from ${attack.ip}`,
    `- ${attack.details}`
  );
  
  // Log to database
  logAttackToDb(attack);
}
