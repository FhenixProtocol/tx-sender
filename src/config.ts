import * as dotenv from "dotenv";

// Load environment variables from a .env file
dotenv.config();

export class Config {
  privateKey: string;

  constructor() {
    // Attempt to load private key from .env first
    const envPrivateKey = process.env.PRIVATE_KEY;

    if (!envPrivateKey) {
      throw new Error(
        "No private key found! Either provide it via the environment variable 'PRIVATE_KEY' or pass it during initialization."
      );
    }

    this.privateKey = envPrivateKey;
  }

  // Update private key from external input
  setPrivateKey(key: string): void {
    if (!key) {
      throw new Error("Invalid private key provided.");
    }
    this.privateKey = key;
  }
}
