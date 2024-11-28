import { Config } from "./config";
export { TransactionManager } from "./transactionManager";

export const config = new Config();

export function greet(): void {
  console.log(`Using private key: ${config.privateKey}`);
}
