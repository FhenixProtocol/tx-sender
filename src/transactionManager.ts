import { Wallet, JsonRpcProvider, TransactionRequest, TransactionResponse } from "ethers";

interface TransactionManagerConfig {
  privateKey: string;                // Ethereum private key
  rpcUrl: string;                    // Ethereum RPC URL
  chainId?: number;                  // Optional chain ID for Ethereum
  broadcast?: boolean;               // Whether to automatically broadcast transactions
}

export class TransactionManager {
  private provider: JsonRpcProvider;
  private wallet: Wallet;
  private nonce: number | null = null;
  private broadcast: boolean;

  constructor(config: TransactionManagerConfig) {
    const { privateKey, rpcUrl, chainId, broadcast = false } = config;

    if (!privateKey || !rpcUrl) {
      throw new Error("Private key and RPC URL are required.");
    }

    this.provider = new JsonRpcProvider(rpcUrl, chainId);
    this.wallet = new Wallet(privateKey, this.provider);
    this.broadcast = broadcast;
  }

  /**
   * Initializes and tracks the nonce for the account.
   */
  private async getNonce(): Promise<number> {
    if (this.nonce === null) {
      this.nonce = await this.provider.getTransactionCount(this.wallet.address, "pending");
    }
    return this.nonce;
  }

  /**
   * Increments the nonce after a transaction.
   */
  private incrementNonce(): void {
    if (this.nonce !== null) {
      this.nonce += 1;
    }
  }

  /**
   * Prepares and signs a transaction.
   */
  public async signTransaction(tx: Partial<TransactionRequest>): Promise<string> {
    // Ensure the nonce is set
    const nonce = await this.getNonce();
    const transaction = { ...tx, nonce };

    // Sign the transaction
    const signedTx = await this.wallet.signTransaction(transaction);

    // Increment nonce for the next transaction
    this.incrementNonce();

    return signedTx;
  }

  /**
   * Broadcasts a signed transaction to the network.
   */
  public async broadcastTransaction(signedTx: string): Promise<TransactionResponse> {
    return await this.provider.broadcastTransaction(signedTx);
  }

  /**
   * Sends a transaction: Signs and optionally broadcasts it.
   */
  public async sendTransaction(
    tx: Partial<TransactionRequest>
  ): Promise<{ signedTx: string; txResponse?: TransactionResponse }> {
    // Sign the transaction
    const signedTx = await this.signTransaction(tx);

    // Broadcast the transaction if specified
    if (this.broadcast) {
      const txResponse = await this.broadcastTransaction(signedTx);
      return { signedTx, txResponse };
    }

    return { signedTx };
  }
}
