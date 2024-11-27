import * as dotenv from "dotenv";

// Load environment variables from a .env file
dotenv.config();

export class Config {
  privateKey?: string;

  constructor(_privateKey?: string) {
    // Attempt to load private key from arg first
    if (_privateKey) {
      this.privateKey = _privateKey;
      return;
    }

    // Attempt to load private key from arg first
    const envPrivateKey = process.env.PRIVATE_KEY;

    if (envPrivateKey) {
      this.privateKey = envPrivateKey;
    }
  }

  // Update private key from external input
  setPrivateKey(key: string): void {
    if (!key) {
      throw new Error("Invalid private key provided.");
    }
    this.privateKey = key;
  }
}
