import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Server
  host: process.env.HOST || '0.0.0.0',
  port: parseInt(process.env.PORT || '8080', 10),
  isDevelopment: process.env.NODE_ENV !== 'production',
  
  // Database
  databasePath: process.env.DATABASE_PATH || './data/waf.db',
  
  // Rate Limiting
  rateLimitRequests: parseInt(process.env.RATE_LIMIT_REQUESTS || '100', 10),
  rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60', 10), // seconds
  rateLimitBan: parseInt(process.env.RATE_LIMIT_BAN || '300', 10), // seconds
  
  // Request Limits
  maxRequestSize: parseInt(process.env.MAX_REQUEST_SIZE || '10485760', 10), // 10MB
  maxHeaderSize: parseInt(process.env.MAX_HEADER_SIZE || '8192', 10), // 8KB
  maxUrlLength: parseInt(process.env.MAX_URL_LENGTH || '2048', 10),
  
  // Attack Response
  attackBanDuration: parseInt(process.env.ATTACK_BAN_DURATION || '3600', 10), // 1 hour
  
  // Features
  enableRateLimiting: process.env.ENABLE_RATE_LIMITING !== 'false',
  enableGeoBlocking: process.env.ENABLE_GEO_BLOCKING === 'true',
  
  // CORS
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(','),
  
  // Backend Services
  backendServices: parseBackendServices()
};

function parseBackendServices() {
  const services = process.env.BACKEND_SERVICES;
  if (!services) {
    return [{
      name: 'default',
      url: 'http://localhost:3000',
      pathPrefix: '/'
    }];
  }
  
  try {
    return JSON.parse(services);
  } catch (err) {
    console.error('Failed to parse BACKEND_SERVICES:', err);
    return [];
  }
}

// Validate critical config
if (config.port < 1 || config.port > 65535) {
  throw new Error('Invalid port number');
}

if (config.rateLimitRequests < 1) {
  throw new Error('Rate limit requests must be at least 1');
}

export default config;
