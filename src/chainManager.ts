import { Wallet, JsonRpcProvider, TransactionRequest, TransactionResponse } from "ethers";
import { formatEther, parseEther, getBigInt } from "ethers";

export interface ChainManagerConfig {
  rpcUrl: string;                    // Ethereum RPC URL
  chainId?: number;                  // Optional chain ID for Ethereum
  broadcast?: boolean;               // Whether to automatically broadcast transactions
  privateKey: string;                // Ethereum private key
  feeMultiplier?: bigint;            // Fee multiplier for gas estimation
  blockTag?: string;                 // Block tag to use for transaction count
}

export interface RobustTxConfig {
    timeout?: number;          // Timeout for each attempt in ms (default: 30000)
    maxRetryAttempts?: number;      // Maximum number of retry attempts (default: infinite)
    gasIncreaseFactor?: number; // Factor to increase gas by on retry (default: 1.2)
    retryDelay?: number;      // Delay between retries in ms (default: 1000)
    maxRetryDelay?: number;   // Maximum delay between retries (default: 30000)
    maxGasPrice?: bigint;     // Maximum gas price willing to pay
    confirmations?: number;   // Number of confirmations to wait for
    useExponentialBackoff?: boolean; // Use exponential backoff instead of linear (default: false)
}

export class ChainManager {
  private provider: JsonRpcProvider;
  private wallet: Wallet;
  private nonce: number | null = null;
  private nonceSyncing: Promise<number> | null = null;
  private broadcast: boolean;
  private chainId: number | undefined = undefined;
  private balance: bigint = BigInt(0);
  private feeMultiplier: bigint = BigInt(12) / BigInt(10);
  private blockTag: string = "finalized";

  constructor(config: ChainManagerConfig) {
    const { privateKey, rpcUrl, chainId, broadcast = false, feeMultiplier = BigInt(12) / BigInt(10), blockTag = "finalized"} = config;

    if (!privateKey || !rpcUrl) {
      throw new Error("Private key and RPC URL are required.");
    }
    this.provider = new JsonRpcProvider(rpcUrl, chainId);
    this.wallet = new Wallet(privateKey, this.provider);
    this.broadcast = broadcast;
    this.chainId = chainId;
    this.feeMultiplier = feeMultiplier;
    this.blockTag = blockTag;

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
      this.nonceSyncing = this.provider.getTransactionCount(this.wallet.address, this.blockTag);
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

    // Only set nonce if not provided by user
    if (tx.nonce === undefined) {
        await this.getNonce();
        tx.nonce = this.nonce;

        // increment nonce
        this.incrementNonce();
    }

    // Sign the transaction
    const signedTx = await this.wallet.signTransaction(tx);
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

  private checkForMessageInError(error: unknown, message: string): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'message' in error &&
      typeof (error as { message: unknown }).message === 'string' &&
      (error as { message: string }).message.includes(message)
    )
  }

  private isMethodNotFound(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (
        (error as { code: number }).code === -32601 ||
        (
          'message' in error &&
          typeof (error as { message: unknown }).message === 'string' &&
          (error as { message: string }).message.includes("method not found")
        )
      )
    );
  }

  private async getFeeForChain(multiplier: bigint) {
    try {
      // Attempt EIP-1559 fee estimation
      const priorityFee = BigInt(await this.provider.send("eth_maxPriorityFeePerGas", []));
      const latestBlock = await this.provider.getBlock("latest");
      if (latestBlock === null) {
        throw new Error("Failed to fetch latest block");
      }

      const baseFee = latestBlock.baseFeePerGas;
      if (baseFee === null) {
        throw new Error("Failed to fetch base fee");
      }
      return {
        maxFeePerGas: baseFee + (priorityFee * multiplier),
        maxPriorityFeePerGas: priorityFee * multiplier,
      }
    } catch (error) {
      // Type guard for error object with code property
      if (this.isMethodNotFound(error) || this.checkForMessageInError(error, "Failed to fetch base fee")) {
        // Fall back to `eth_gasPrice` for legacy chains
        const feeData = await this.provider.getFeeData();
        if (!feeData.gasPrice) throw new Error("Failed to get gas price");
        return {
          gasPrice: feeData.gasPrice * multiplier,
        };
      } else {
        throw error;
      }
    }
  }

  /**
   * Applies an increase factor to the gas parameters of a transaction
   * This is used to increase the gas price of a transaction to improve mempool acceptance
   * This will multiply the gas price/maxFeePerGas/maxPriorityFeePerGas by the increase factor
   * @param tx - The transaction to apply the increase factor to
   * @param increaseFactor - The factor to increase the gas price by
   * @returns The transaction with the increased gas price
   */
  private async applyGasIncreaseFactor(
      tx: Partial<TransactionRequest>,
      increaseFactor: number
  ): Promise<Partial<TransactionRequest>> {
      if (increaseFactor <= 1) return tx;

      const multiplier = BigInt(Math.floor(increaseFactor * 100)) / BigInt(100);
      const feeData = await this.getFeeForChain(this.feeMultiplier);

      const newTx = { ...tx }; // Create a new object to avoid modifying the input


      // EIP-1559 fee estimation, this is the recommended way to estimate fees


      if ('maxFeePerGas' in feeData && feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
          newTx.maxFeePerGas = feeData.maxFeePerGas * multiplier;
          newTx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * multiplier;
      } else if ('gasPrice' in feeData && feeData.gasPrice) {
          newTx.gasPrice = feeData.gasPrice * multiplier;
      }

      return newTx;
  }

  /**
   * Estimates the gas cost for a transaction and validates the wallet balance.
   */
  private async validateFunds(tx: Partial<TransactionRequest>): Promise<Partial<TransactionRequest>> {
    let gasEstimate;
    if (tx.gasLimit === undefined) {
      const txWithLimit = { ...tx, gasLimit: 1_000_000 };
      // Since the gas is being estimated, with binary search, we can use a relative low gas limit
      // to avoid wasting gas on the estimation itself
      // In the worst case, the gas limit will be increased to the estimated value - dynamically
      gasEstimate = await this.provider.estimateGas({...txWithLimit, from: this.wallet.address});
      tx.gasLimit = gasEstimate * 110n / 100n;
      const feeData = await this.getFeeForChain(this.feeMultiplier);
      Object.assign(tx, feeData);
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
    } else if (getBigInt(tx.gasLimit!) > gasEstimate * 125n / 100n) {
      console.warn("Warning: Gas limit is higher than estimated,", tx.gasLimit, ">", gasEstimate);
    }

    if (tx.gasPrice === undefined) {
      tx.gasPrice = gasPrice;
    } else if (getBigInt(tx.gasLimit!) < gasPrice) {
      console.warn("Warning: Gas price is lower than recommended.", tx.gasPrice, "<", gasPrice);
    }

    if (cost > this.balance) {
      // retry just in case it was missed
      await this.syncBalance();
      if (cost > this.balance) {
        console.error("Insufficient funds for transaction. Account", this.wallet.address, "'s balance:", this.balance, "wanted:", cost);
        throw new Error(`Insufficient funds for transaction. Account ${this.wallet.address}'s balance:, ${this.balance}, wanted: , ${cost}`);
      }
    }

    if (this.balance - BigInt(cost) < parseEther("0.1")) {
      console.warn("Warning: Wallet funds are running low, balance:", this.balance);
      console.warn("balance after tx:", this.balance - BigInt(cost));
    }

    return tx;
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
  public async _sendTransaction(
    tx: Partial<TransactionRequest>
  ): Promise<{ signedTx: string; txResponse?: TransactionResponse }> {
    this.addChainId(tx);

    // Validate balance and estimate gas
    tx = await this.validateFunds(tx);

    // Sign the transaction
    const signedTx = await this.signTransaction(tx);

    // Broadcast the transaction if specified
    if (this.broadcast) {
      const txResponse = await this.broadcastTransaction(signedTx);
      // Sync balance after broadcast
      await this.syncBalance();
      return { signedTx, txResponse };
    }

    return { signedTx };
  }

  /**
   * Sends a transaction with automatic retry and gas price adjustment for stuck transactions.
   * This function will:
   * 1. Send the transaction with initial gas settings
   * 2. Wait for confirmation with the specified timeout
   * 3. If the transaction gets stuck in mempool:
   *    - Retry with increased gas price using gasIncreaseFactor
   *    - Keep retrying with exponentially increasing gas until either:
   *      a) Transaction is confirmed
   *      b) Max attempts reached (if specified)
   *      c) Max gas price exceeded (if specified)
   *
   * @param tx - The transaction to send
   * @param config - Configuration options for the robust transaction sending
   * @param config.timeout - Time to wait for confirmation before retrying (ms) (default: 30000)
   * @param config.maxAttempts - Maximum number of retry attempts (default: infinite)
   * @param config.gasIncreaseFactor - Multiply gas price by this factor on each retry (default: 1.2)
   * @param config.retryDelay - Initial delay between retries in ms (default: 1000)
   * @param config.maxRetryDelay - Maximum delay between retries in ms (default: 30000)
   * @param config.maxGasPrice - Maximum gas price willing to pay (in wei) (optional)
   * @param config.confirmations - Number of confirmations to wait for (default: 1)
   *
   * @returns Promise resolving to object containing:
   *          - signedTx: The signed transaction data
   *          - txResponse: The transaction response from the network
   *
   * @throws Error if:
   *         - Transaction fails to broadcast
   *         - Max attempts reached without confirmation
   *         - Gas price exceeds maxGasPrice if provided
   *         - Network error occurs
   */
  public async sendTransaction(
    tx: Partial<TransactionRequest>,
    config: RobustTxConfig = {}
  ): Promise<{ signedTx: string; txResponse: TransactionResponse }> {
    const {
        timeout = 30000,
        maxRetryAttempts = 1,
        gasIncreaseFactor = 1.1,
        retryDelay = 1000,
        maxRetryDelay = 30000,
        confirmations = 1,
        useExponentialBackoff = true
    } = config;

    let attempt = 0;
    let lastError: Error | null = null;
    let nonceForThisTransaction: number | null = null;
    let lastTxResponse: TransactionResponse | null = null;
    let currentResult: { signedTx: string; txResponse?: TransactionResponse } | null = null;
    const isUserProvidedNonce = tx.nonce !== undefined;

    // If the nonce is provided by the user, use it
    if (isUserProvidedNonce && tx.nonce !== undefined) {
      nonceForThisTransaction = tx.nonce;
    }

    // Add mempool check
    const checkMempoolStuck = async (txResponse: TransactionResponse): Promise<boolean> => {
        try {
            const tx = await this.provider.getTransaction(txResponse.hash);
            // If transaction is still pending after timeout, consider it stuck
            return tx !== null && tx.blockNumber === null;
        } catch (error) {
            return false;
        }
    };

    while (maxRetryAttempts === undefined || attempt <= maxRetryAttempts) {
        try {
            if (attempt > 0) {
                const backoffDelay = useExponentialBackoff ? Math.min(
                    retryDelay * Math.pow(2, attempt - 1),
                    maxRetryDelay
                ) : retryDelay;
                await new Promise(resolve => setTimeout(resolve, backoffDelay));

                // Only reuse managed nonce, don't override user's nonce
                if (!isUserProvidedNonce && nonceForThisTransaction !== null) {
                    tx.nonce = nonceForThisTransaction;
                }

                // First validate the transaction with current gas prices
                tx = await this.validateFunds(tx);

                // Calculate increase factor for better mempool acceptance
                const increaseFactor = Math.pow(gasIncreaseFactor, attempt);

                // Then apply the gas increase on top of the validated transaction
                tx = await this.applyGasIncreaseFactor(tx, increaseFactor);

                // Check against max gas price if specified
                if (config.maxGasPrice) {
                    const effectiveGasPrice = tx.maxFeePerGas || tx.gasPrice;
                    if (effectiveGasPrice && BigInt(effectiveGasPrice) > config.maxGasPrice) {
                        throw new Error("Gas price exceeded maximum allowed");
                    }
                }

                console.warn(`Retrying transaction with ${increaseFactor}x gas price. Attempt ${attempt + 1}${maxRetryAttempts ? '/' + maxRetryAttempts : ''}`);
            }
            
            // Send the transaction
            currentResult = await this._sendTransaction(tx);

            if (!currentResult.txResponse) {
                throw new Error("Transaction was not broadcast");
            }

            // Update nonce for this transaction
            nonceForThisTransaction = currentResult.txResponse.nonce;

            // Wait for confirmation with timeout
            try {
                await currentResult.txResponse.wait(confirmations, timeout);

                lastTxResponse = currentResult.txResponse;
                return currentResult as { signedTx: string; txResponse: TransactionResponse };
            } catch (error) {
                if (error instanceof Error && error.message.toLowerCase().includes("timeout")) {
                    // Check if transaction is stuck in mempool
                    if (await checkMempoolStuck(currentResult.txResponse)) {
                        console.warn("Transaction stuck in mempool, retrying with higher gas...");
                        // Let the retry logic handle it
                        throw error;
                    }
                }
                throw error;
            }

        } catch (error) {
          lastError = error as Error;

          // If we've exhausted our attempts, throw the last error
          if (maxRetryAttempts !== undefined && attempt >= maxRetryAttempts - 1) {
              throw new Error(`Failed to send transaction after ${maxRetryAttempts} attempts: ${lastError.message} with nonce ${nonceForThisTransaction} and tx hash ${currentResult?.txResponse?.hash}`);
          }

          // Check if error indicates nonce too low, sync nonce
          if (error instanceof Error && (error.message.includes("nonce too low") || error.message.includes("NONCE_EXPIRED"))) {
            // this will force the nonce to be fetched again
            tx.nonce = null;
            nonceForThisTransaction = null;
            attempt++;
            continue;
          }

          // Handle network errors differently
          if (error instanceof Error &&
              (error.message.includes("network") || error.message.includes("connection"))) {
              console.warn("Network error detected, waiting longer before retry...");
              await new Promise(resolve => setTimeout(resolve, maxRetryDelay));
              attempt++;
              continue;
          }

          attempt++;
        } finally {
            if (currentResult?.txResponse) {
                lastTxResponse = null;
                lastError = null;
            }
        }
    }

    throw lastError || new Error("Failed to send transaction");
  }

  public updateBlockTag(blockTag: string): void {
    this.blockTag = blockTag;
  }

}
