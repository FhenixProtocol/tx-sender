import dotenv from 'dotenv';
import path from 'path';

export function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env'); // Points to the importing project's directory
  const result = dotenv.config({ path: envPath });

  if (result.error) {
    console.warn(`Could not load .env file from ${envPath}:`, result.error.message);
  } else {
    console.log(`Loaded .env file from ${envPath}`);
  }
}
