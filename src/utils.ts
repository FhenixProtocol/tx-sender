import dotenv from 'dotenv';
import path from 'path';
import { Logger } from 'winston';

export function loadEnv(logger: Logger) {
  const envPath = path.resolve(process.cwd(), '.env'); // Points to the importing project's directory
  const result = dotenv.config({ path: envPath });

  if (result.error) {
    logger.warn(`Could not load .env file from ${envPath}:`, {error: result.error.message});
  } else {
    logger.info(`Loaded .env file from ${envPath}`);
  }
}
