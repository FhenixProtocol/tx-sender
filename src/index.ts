import { Config } from "./config";

export const config = new Config();

export function greet(): void {
  console.log(`Using private key: ${config.privateKey}`);
}
