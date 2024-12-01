import { Wallet, JsonRpcProvider, TransactionRequest, TransactionResponse } from "ethers";

export interface ChainManagerConfig {
  privateKey: string;                // Ethereum private key
  rpcUrl: string;                    // Ethereum RPC URL
  chainId?: number;                  // Optional chain ID for Ethereum
  broadcast?: boolean;               // Whether to automatically broadcast transactions
}

export class ChainManager {
  private provider: JsonRpcProvider;
  private wallet: Wallet;
  private nonce: number | null = null;
  private nonceSyncing: Promise<number> | null = null;
  private broadcast: boolean;
  private chainId: number | undefined = undefined;

  constructor(config: ChainManagerConfig) {
    const { privateKey, rpcUrl, chainId, broadcast = false } = config;

    if (!privateKey || !rpcUrl) {
      throw new Error("Private key and RPC URL are required.");
    }

    this.provider = new JsonRpcProvider(rpcUrl, chainId);
    this.wallet = new Wallet(privateKey, this.provider);
    this.broadcast = broadcast;
    this.chainId = chainId;
    console.log("received chainId:", chainId);

    console.log("nonce is null, getting nonce from provider");
  }

  /**
   * Initializes the Nonce accoring to the chain state.
   */
  private async syncNonce(): Promise<void> {
    if (this.nonce === null) {
      // console.log("nonce is null, syncing nonce from provider");
      this.nonceSyncing = this.provider.getTransactionCount(this.wallet.address, "pending");
      this.nonce = await this.nonceSyncing;
    }
  }

  /**
   * Initializes and tracks the nonce for the account.
   */
  private async getNonce(): Promise<number> {
    if (this.nonce === null && this.nonceSyncing !== null) {
      this.nonce = await this.nonceSyncing;
    } else if (this.nonce === null) {
      await this.syncNonce();
    }
    return this.nonce!;
  }

  /**
   * Increments the nonce after a transaction.
   */
  private incrementNonce(): void {
    console.log("incrementing nonce");
    if (this.nonce !== null) {
      this.nonce += 1;
    } else if (this.nonceSyncing === null) {
      console.warn("tx-sender: warning: nonce expected to be syncing");
    } else {
      this.nonceSyncing.then(n => {
        if (this.nonce === null) {
          console.warn("tx-sender: warning: nonce not expected to be null");
          this.nonce = n;
        } else {
          this.nonce += 1;
        }
      });
    }

    console.log("nonce:", this.nonce);
  }

  /**
   * Prepares and signs a transaction.
   */
  public async signTransaction(tx: Partial<TransactionRequest>): Promise<string> {
    this.addChainId(tx);

    // Ensure the nonce is set
    await this.getNonce();

    // use latest nonce
    const nonce = this.nonce
    console.log("signing transaction with nonce", nonce);
    const transaction = { ...tx, nonce };

    // Increment nonce for the next transaction
    this.incrementNonce();

    // Sign the transaction
    const signedTx = await this.wallet.signTransaction(transaction);

    return signedTx;
  }

  /**
   * Broadcasts a signed transaction to the network.
   */
  private addChainId(tx: Partial<TransactionRequest>): void {
    if (tx.chainId === undefined) {
      tx.chainId = this.chainId;
    }
    if (tx.chainId === undefined) {
      throw Error("chainId is required");
    }
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
