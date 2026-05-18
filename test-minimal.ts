import { logger, apiLogger } from './src/utils/logger';
import { encryptionService } from './src/services/encryptionService';

console.log('DEBUG: test-minimal.ts start');
logger.info('Test logger info');

console.log('DEBUG: test-minimal.ts: importing cacheManager');
import { cacheManager } from './src/services/cacheManager';
console.log('DEBUG: test-minimal.ts: cacheManager imported');

logger.info('Test apiLogger info');
console.log('DEBUG: test-minimal.ts end');
process.exit(0);
