import { Wallet, JsonRpcProvider, TransactionRequest, TransactionResponse } from "ethers";
import { formatEther, parseEther, getBigInt } from "ethers";

export interface ChainManagerConfig {
  rpcUrl: string;                    // Ethereum RPC URL
  chainId?: number;                  // Optional chain ID for Ethereum
  broadcast?: boolean;               // Whether to automatically broadcast transactions
  privateKey: string;                // Ethereum private key
}

export class ChainManager {
  private provider: JsonRpcProvider;
  private wallet: Wallet;
  private nonce: number | null = null;
  private nonceSyncing: Promise<number> | null = null;
  private broadcast: boolean;
  private chainId: number | undefined = undefined;
  private balance: bigint = BigInt(0);

  constructor(config: ChainManagerConfig) {
    const { privateKey, rpcUrl, chainId, broadcast = false } = config;

    if (!privateKey || !rpcUrl) {
      throw new Error("Private key and RPC URL are required.");
    }
    this.provider = new JsonRpcProvider(rpcUrl, chainId);
    this.wallet = new Wallet(privateKey, this.provider);
    this.broadcast = broadcast;
    this.chainId = chainId;

    // Fetch initial wallet balance
    this.syncBalance().catch(err => {
      console.error("Failed to fetch initial balance:", err);
    });
  }

  /**
   * Fetches and syncs the current wallet balance.
   */
  private async syncBalance(): Promise<void> {
    const balance = await this.provider.getBalance(this.wallet.address);
    this.balance = balance;
    // console.log(`Wallet balance synced: ${formatEther(this.balance)} ETH`);
  }

  /**
   * Initializes the Nonce according to the chain state.
   */
  private async syncNonce(): Promise<void> {
    if (this.nonce === null) {
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
    // console.log("incrementing nonce");
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

    // console.log("nonce:", this.nonce);
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
    // console.log("signing transaction with nonce", nonce);
    const transaction = { ...tx, nonce };

    // Increment nonce for the next transaction
    this.incrementNonce();

    // Sign the transaction
    const signedTx = await this.wallet.signTransaction(transaction);
    return signedTx;
  }

  /**
   * Adds the chain ID to the transaction if not set.
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
   * Estimates the gas cost for a transaction and validates the wallet balance.
   */
  private async validateFunds(tx: Partial<TransactionRequest>): Promise<void> {
    let gasEstimate;
    if (tx.gasLimit === undefined) {
      // Using current balance as limit for estimation
      const txWithLimit = { ...tx, gasLimit: 1_000_000 };
      console.log("The gas limit is undefined, using current 1Mil as limit for estimation:", txWithLimit.gasLimit);
      // Since the gas is being estimated, with binary search, we can use a relative low gas limit 
      // to avoid wasting gas on the estimation itself
      // In the worst case, the gas limit will be increased to the estimated value - dynamically
      gasEstimate = await this.provider.estimateGas(txWithLimit);
    } else {
      console.log("Using given gaslimit for estimation:", tx.gasLimit);
      gasEstimate = await this.provider.estimateGas(tx);
    }

    const gasPrice = (await this.provider.getFeeData()).gasPrice;
    if (gasPrice === null) {
      throw new Error("Failed to fetch gas price.");
    }
    const cost = gasEstimate * gasPrice;

    // console.log(`Estimated Gas: ${gasEstimate}, Gas Price: ${formatEther(gasPrice)} ETH`);
    // console.log(`Estimated Cost: ${formatEther(cost)} ETH`);

    if (tx.gasLimit === undefined) {
      tx.gasLimit = gasEstimate;
    } else if (getBigInt(tx.gasLimit!) < gasEstimate) {
      console.error("Gas limit is too low for transaction,", tx.gasLimit, "<", gasEstimate);
      throw new Error("Gas limit is too low for transaction.", );
    } else if (getBigInt(tx.gasLimit!) > gasEstimate) {
      console.warn("Warning: Gas limit is higher than estimated,", tx.gasLimit, ">", gasEstimate);
    }

    if (tx.gasPrice === undefined) {
      tx.gasPrice = gasPrice;
    } else if (getBigInt(tx.gasLimit!) < gasPrice) {
      console.warn("Warning: Gas price is lower than recommended.", tx.gasPrice, "<", gasPrice);
    }

    if (cost > this.balance) {
      throw new Error(`Insufficient funds for transaction. Account ${this.wallet.address}'s balance:, ${this.balance}, wanted: , ${cost}`);
    }

    if (this.balance - cost < parseEther("0.1")) {
      console.warn("Warning: Wallet funds are running low, balance:", this.balance);
      console.warn("balance after tx:", this.balance - cost);
    }
  }

  /**
   * Broadcasts a signed transaction to the network.
   */
   public async broadcastTransaction(signedTx: string): Promise<TransactionResponse> {
     return this.provider.broadcastTransaction(signedTx);
   }

  /**
   * Sends a transaction: Signs and optionally broadcasts it.
   */
  public async sendTransaction(
    tx: Partial<TransactionRequest>
  ): Promise<{ signedTx: string; txResponse?: TransactionResponse }> {
    this.addChainId(tx);

    // Validate balance and estimate gas
    await this.validateFunds(tx);
    console.log("Funds validated");
    // Sign the transaction
    const signedTx = await this.signTransaction(tx);
    console.log("Signed transaction", JSON.stringify(signedTx));

    // Broadcast the transaction if specified
    if (this.broadcast) {
      console.log("Broadcasting transaction", JSON.stringify(signedTx));
      const txResponse = await this.broadcastTransaction(signedTx);
      // Sync balance after broadcast
      await this.syncBalance();
      return { signedTx, txResponse };
    }

    return { signedTx };
  }
}
