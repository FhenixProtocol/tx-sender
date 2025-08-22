import { Wallet, JsonRpcProvider, TransactionRequest, TransactionResponse, sha256, ethers } from "ethers";
import { parseEther, getBigInt } from "ethers";
import { Logger } from "winston";
const BLOCK_TIME = 13000; // 13 seconds, typical Ethereum block time is 12-13 seconds

/**
 * Function type for transaction telemetry reporting
 * @param id - Unique identifier for the transaction event
 * @param status - Current status of the transaction (e.g. "pending", "confirmed")
 * @param chainId - ID of the blockchain network
 * @param txTo - Destination address of the transaction
 * @param nonce - Transaction nonce value
 */
export type TxTelemetryFunction = (id: number, status: string, chainId: number, txTo: string, nonce: number, extraInfo: string) => void;

function verifyNonceTooLow(errorMessage: string): boolean {
    return errorMessage.includes("nonce too low") || errorMessage.includes("NONCE_EXPIRED");
}

function verifyNonceTooHigh(errorMessage: string): boolean {
  return errorMessage.includes("nonce too high");
}

function verifyReplacementFeeIssue(errorMessage: string): boolean {
  return errorMessage.includes("replacement fee too low") || errorMessage.includes("future transaction tries to replace pending");
}

function isNetworkError(errorMessage: string): boolean {
    return errorMessage.includes("network") || errorMessage.includes("connection");
}

  //Block tags:
  //"earliest" for the earliest/genesis block
  //"latest" - for the latest mined block
  //"safe" - for the latest safe head block
  //"finalized" - for the latest finalized block
  //"pending" - for the pending state/transactions
export interface ChainManagerConfig {
  rpcUrl: string;                    // Ethereum RPC URL
  chainId?: number;                  // Optional chain ID for Ethereum
  broadcast?: boolean;               // Whether to automatically broadcast transactions
  privateKey: string;                // Ethereum private key
  feeMultiplier?: number;            // Fee multiplier for gas estimation
  blockTag?: string;                 // Block tag to use for transaction count
  maxTxsAtOnce?: number;             // Maximum number of transactions to send at once
  minPriorityFee?: number;           // Minimum priority fee to use for gas estimation in WEI (default: 2_000_000_000)
  txGasLimit? : number;              // Gas limit to use for transactions (default: 5_000_000)
}

export interface TxConfig {
    timeout?: number;          // Timeout for each attempt in ms (default: 2*BLOCK_TIME)
    maxRetryAttempts?: number;      // Maximum number of retry attempts (default: infinite)
    feeIncreaseFactor?: number; // Factor to increase gas by on retry (default: 1.11)
    retryDelay?: number;      // Delay between retries in ms (default: 0)
    retryDelayOnNetworkIssues?: number; // Delay between retries on network issues in ms (default: 250)
    maxGasPrice?: bigint;     // Maximum gas price the sender is willing to pay
    confirmations?: number;   // Number of confirmations to wait for
    useExponentialBackoff?: boolean; // Use exponential backoff instead of linear (default: true)
    maxDelayAllowed?: number; // Maximum delay allowed in ms (default: 10000) we can also pass undefined which means no limit
    exponentialBackoffExponent?: number; // Exponent for exponential backoff (default: 10)
}

export interface FeeData {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  lastErrorIsTimeout?: boolean;
}

enum TransactionStatus {
  STUCK_IN_MEMPOOL = "STUCK_IN_MEMPOOL",
  NO_TX = "NO_TX",
  SUCCEEDED = "SUCCEEDED"
}

export class ChainManager {
  private provider: JsonRpcProvider;
  private wallet: Wallet;
  private nonce: number | undefined = undefined;
  private broadcast: boolean;
  private chainId: number | undefined = undefined;
  private balance: bigint = BigInt(0);
  private chainSpecificFeeMultiplier: number = 1.1;
  private minPriorityFee: number = 2_000_000_000;
  private ready: boolean = false;
  private logger: Logger;
  private maxTxsAtOnce: number = 20;
  private txGasLimit: number = 5_000_000;
  private activeTxsCounter: number = 0;
  constructor(config: ChainManagerConfig, logger: Logger) {
    const { privateKey, rpcUrl, chainId, broadcast = false, feeMultiplier = 1.1, maxTxsAtOnce = 20, minPriorityFee = 2_000_000_000, txGasLimit = 5_000_000} = config;

    if (!privateKey || !rpcUrl) {
      throw new Error("Private key and RPC URL are required.");
    }
    
    // staticNetwork - do not request chain ID on requests to validate the underlying chain has not changed
    this.provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: ethers.Network.from(chainId) });
    this.wallet = new Wallet(privateKey, this.provider);
    this.broadcast = broadcast;
    this.chainId = chainId;
    this.chainSpecificFeeMultiplier = feeMultiplier;
    this.minPriorityFee = minPriorityFee;
    this.logger = logger;
    this.maxTxsAtOnce = maxTxsAtOnce;
    this.txGasLimit = txGasLimit;
    this.activeTxsCounter = 0;
    this.logger.info("ChainManager initialized", {chainId: this.chainId, maxTxsAtOnce: this.maxTxsAtOnce, address: this.wallet.address});
  }

  public isReady(): boolean {
    return this.ready;
  }

  public async init(): Promise<void> {
    this.logger.info("ChainManager initialized", {chainId: this.chainId, maxTxsAtOnce: this.maxTxsAtOnce});
    
    // Fetch initial wallet balance
    await this.syncBalance().catch(err => {
      this.logger.error("Failed to fetch initial balance:", err);
    });

    // Fetch initial nonce
    await this.syncNonce().catch(err => {
      this.logger.error("Failed to fetch initial nonce:", err);
    });

    // make sure there are no pending transactions
    await this.handleStuckTransactions().catch(err => {
      this.logger.error("Failed to handle stuck transactions:", err);
    });
    
    this.ready = true;
    this.logger.info("chainManager is ready", {chainId: this.chainId});
  }
  
  private async handleStuckTransactions(): Promise<void> {
    const latestNonce = await this.provider.getTransactionCount(this.wallet.address, "latest");
    this.logger.info("Handling stuck transactions", {chainId: this.chainId, latestNonce: latestNonce, nonce: this.nonce});
    if (this.nonce !== undefined && latestNonce < this.nonce) {
      this.logger.warn("There are pending transactions, this could cause issues with the nonce sync, we'll treat them as stuck");
      
      // Create dummy transaction
      let dummyTx: Partial<TransactionRequest> = {
        to: this.wallet.address,
        value: parseEther("0"),
      };
      for (let i = latestNonce; i < this.nonce; i++) {
        // set the nonce
        dummyTx.nonce = i;
        
        // Send the transaction
        const tx = await this.sendTransaction(dummyTx, {
          timeout: 2*BLOCK_TIME,
          maxRetryAttempts: undefined,
          feeIncreaseFactor: 1.11,
          retryDelay: 0,
        });
        if (tx.txResponse) {
          const txResponse = tx.txResponse as TransactionResponse;
          this.logSuccessUnstuckedTx(txResponse, true);
        }
      }
    }

    if (this.nonce !== undefined && this.nonce !== latestNonce) {
      throw new Error("Nonce is not synced, this could cause issues with the nonce sync, failed to release stuck transactions");
    }

    this.ready = true;
  }

  private logSuccessUnstuckedTx(txResponse: TransactionResponse, initial: boolean = false, eventId: number = 0, telemetryFunction: TxTelemetryFunction | null = null): void {
    if (telemetryFunction) {
      telemetryFunction(eventId, `transaction_succeeded_unstucked_${initial ? "init" : "retry"}_${txResponse.hash}`, this.chainId ?? 0, txResponse.to?.toString() ?? "", txResponse.nonce, "");
    }
    if (txResponse.maxFeePerGas) {
      this.logger.info("chainManager unstuck transaction", {txType: initial ? "init" : "retry", nonce: txResponse.nonce, fee: txResponse.maxFeePerGas, data: txResponse.data});
    } else if (txResponse.gasPrice) {
      this.logger.info("chainManager unstuck transaction", {txType: initial ? "init" : "retry", nonce: txResponse.nonce, fee: txResponse.gasPrice, data: txResponse.data});
    }
  }

  /**
   * Fetches and syncs the current wallet balance.
   */
  private async syncBalance(): Promise<void> {
    const balance = await this.provider.getBalance(this.wallet.address);
    this.balance = balance;
  }

  /**
   * Initializes the Nonce according to the chain state.
   */
  private async syncNonce(): Promise<void> {
    if (this.nonce !== undefined) {
      // Nothing to sync here
      return;
    }

    this.nonce = await this.provider.getTransactionCount(this.wallet.address, "pending");

    this.logger.info("chainManager nonce synced", {chainId: this.chainId, nonce: this.nonce});
  }

  /**
   * Initializes and tracks the nonce for the account.
   */
  private async getNonce(): Promise<number> {
    if (this.nonce !== undefined) {
      return this.nonce;
    }

    // If we have no nonce, we need to sync from scratch 
    await this.syncNonce();
    return this.nonce!;
  }

  /**
   * Prepares and signs a transaction.
   */
  public async signTransaction(tx: Partial<TransactionRequest>): Promise<string> {
    tx = this.addChainId(tx);

    this.logger.debug("Signing transaction with fees", {maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, gasPrice: tx.gasPrice, gasLimit: tx.gasLimit});

    // Only set nonce if not provided by user
    if (tx.nonce === undefined) {
        tx.nonce = await this.getNonce();

        if (this.nonce === undefined) {
          this.logger.error("Nonce is undefined after syncing, this should not happen");
          throw new Error("Nonce is undefined after syncing, this should not happen");
        }

        this.nonce += 1;
    }

    // Sign the transaction
    const signedTx = await this.wallet.signTransaction(tx);
    return signedTx;
  }

  /**
   * Adds the chain ID to the transaction if not set.
   */
  private addChainId(tx: Partial<TransactionRequest>): Partial<TransactionRequest> {
    if (tx.chainId === undefined) {
      tx.chainId = this.chainId;
    }
    if (tx.chainId === undefined) {
      throw Error("chainId is required");
    }
    return tx;
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

  private doesTxContainFee(tx: Partial<TransactionRequest>): boolean {
    return tx.maxFeePerGas !== undefined || tx.gasPrice !== undefined;
  }

  private async getFeeForChain(multiplier: number, minPriorityFee: number) {
    try {
      // Attempt EIP-1559 fee estimation
      const priorityFee = BigInt(Math.max(await this.provider.send("eth_maxPriorityFeePerGas", []), minPriorityFee));
      const latestBlock = await this.provider.getBlock("latest");
      if (latestBlock === null) {
        this.logger.error("Failed to fetch latest block");
        throw new Error("Failed to fetch latest block");
      }

      const baseFee = latestBlock.baseFeePerGas;
      if (baseFee === null) {
        this.logger.error("Failed to fetch base fee");
        throw new Error("Failed to fetch base fee");
      }

      // Return only EIP-1559 fields
      const maxPriorityFeePerGas = Number(priorityFee) * multiplier;
      // https://www.blocknative.com/blog/eip-1559-fees see for more details
      const maxFeePerGas = 2 * Number(baseFee) + maxPriorityFeePerGas;
      this.logger.debug("Got fee for chain",{chainId: this.chainId, blockNumber: latestBlock.number, baseFee: baseFee, priorityFee: priorityFee, maxFeePerGas: maxFeePerGas, maxPriorityFeePerGas: maxPriorityFeePerGas})
      return {
        maxFeePerGas: BigInt(Math.ceil(maxFeePerGas)),
        maxPriorityFeePerGas: BigInt(Math.ceil(maxPriorityFeePerGas)),
      }
    } catch (error) {
      if (this.isMethodNotFound(error) || this.checkForMessageInError(error, "Failed to fetch base fee")) {
        // Return only legacy field (gasPrice - eth_gasPrice)
        const feeData = await this.provider.getFeeData();
        if (!feeData.gasPrice) {
          this.logger.error("Failed to get gas price");
          throw new Error("Failed to get gas price");
        }
        return {
          gasPrice: BigInt(Math.ceil(Number(feeData.gasPrice) * multiplier)),
        };
      }
        throw error;
    }
  }

  /**
   * Applies an increase factor to the gas parameters of a transaction
   * This is used to increase the gas price of a transaction to improve mempool acceptance
   * This will multiply the gas price/maxFeePerGas/maxPriorityFeePerGas by the increase factor
   * @param tx - The transaction to apply the increase factor to
   * @param increaseFactor - The factor to increase the gas price by
   * @param prevFee - The previous fee data
   * @returns The transaction with the increased gas price
   */
  private async applyFeeIncreaseFactor(
      tx: Partial<TransactionRequest>,
      increaseFactor: number,
      prevFee: FeeData
  ): Promise<Partial<TransactionRequest>> {
      if (increaseFactor <= 1) return tx;

      const retryMultiplier = Math.floor(increaseFactor * 100) / 100;
      const feeData = await this.getFeeForChain(this.chainSpecificFeeMultiplier, this.minPriorityFee);
      let newTx = { ...tx }; // Create a new object to avoid modifying the input
      newTx = this.setGasFees(newTx, feeData, prevFee, retryMultiplier);
      this.logger.debug("After fees applied", {gasPrice: newTx.gasPrice, maxFeePerGas: newTx.maxFeePerGas, maxPriorityFeePerGas: newTx.maxPriorityFeePerGas});
      return newTx;
  }

  /**
   * Estimates the gas cost for a transaction and validates the wallet balance.
   */
  private async validateFunds(tx: Partial<TransactionRequest>, prevFee: FeeData): Promise<Partial<TransactionRequest>> {
    let gasEstimate;
    if (!this.doesTxContainFee(tx)) {
      const feeData = await this.getFeeForChain(this.chainSpecificFeeMultiplier, this.minPriorityFee);
      tx = this.setGasFees(tx, feeData, prevFee);
    }

    if (tx.gasLimit === undefined) {
      const txWithLimit = { ...tx, gasLimit:  this.txGasLimit};
      // Since the gas is being estimated, with binary search, we can use a relative low gas limit
      // to avoid wasting gas on the estimation itself
      // In the worst case, the gas limit will be increased to the estimated value - dynamically
      this.logger.debug("Estimating gas for transaction", {tx: txWithLimit});
      gasEstimate = await this.provider.estimateGas({...txWithLimit, from: this.wallet.address});
      tx.gasLimit = gasEstimate * 110n / 100n;
    } else {
      this.logger.debug("Using given gaslimit for estimation", {gasLimit: tx.gasLimit});
      if (!this.doesTxContainFee(tx)) {
        this.logger.debug("Stack trace for missing fee:", {error: new Error().stack});
        this.logger.error("Transaction does not contain fee, this could cause issues with the nonce sync, failed to release stuck transactions");
        throw new Error("Transaction does not contain fee, this could cause issues with the nonce sync, failed to release stuck transactions");
      }

      gasEstimate = await this.provider.estimateGas({...tx, from: this.wallet.address});
    }

    if (tx.gasLimit === undefined) {
      tx.gasLimit = gasEstimate;
    } else if (getBigInt(tx.gasLimit!) < gasEstimate) {
      this.logger.error("Gas limit is too low for transaction,", {hint: `${tx.gasLimit} < ${gasEstimate}`});
      throw new Error("Gas limit is too low for transaction.", );
    } else if (getBigInt(tx.gasLimit!) > gasEstimate * 125n / 100n) {
      this.logger.warn("Gas limit is higher than estimated", {hint: `${tx.gasLimit} > ${gasEstimate}`});
    }

    let fee = (tx.gasPrice !== undefined && tx.gasPrice !== null) ? tx.gasPrice : tx.maxFeePerGas;
    if (fee === undefined || fee === null) {
      const gasPrice = (await this.provider.getFeeData()).gasPrice;
      if (gasPrice === null) {
        throw new Error("Failed to fetch gas price.");
      }

      tx.gasPrice = gasPrice;
      fee = gasPrice;
    }

    const cost = gasEstimate * getBigInt(fee);

    if (cost > this.balance) {
      // retry just in case it was missed
      await this.syncBalance();
      if (cost > this.balance) {
        this.logger.error("Insufficient funds for transaction", {account: this.wallet.address, balance: this.balance, wanted: cost});
        throw new Error(`Insufficient funds for transaction. Account ${this.wallet.address}'s balance: ${this.balance}, wanted: ${cost}`);
      }
    }

    if (this.balance - BigInt(cost) < parseEther("0.1")) {
      this.logger.warn("Wallet funds are running low", {balance: this.balance});
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
  private async _sendTransaction(
    tx: Partial<TransactionRequest>,
    prevFee: FeeData
  ): Promise<{ signedTx: string; txResponse?: TransactionResponse }> {
    tx = this.addChainId(tx);

    // Validate balance and estimate gas
    this.logger.debug("Validating transaction with current gas fees (_sendTransaction)", {gasPrice: tx.gasPrice, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas});
    tx = await this.validateFunds(tx, prevFee);

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

  private async checkTransactionStatus(txResponse: TransactionResponse): Promise<TransactionStatus> {
      try {
          const tx = await this.provider.getTransaction(txResponse.hash);
          if (tx === null) {
            return TransactionStatus.NO_TX;
          }

          // If no block number, the tx is still in mempool
          else if (tx.blockNumber === null) {
            return TransactionStatus.STUCK_IN_MEMPOOL;
          }

          // When tx and blockNumber exist, we can safely assume that the tx was included in a block
          return TransactionStatus.SUCCEEDED;
      } catch (error) {
          return TransactionStatus.NO_TX;
      }
  };

  private isTimeoutError(lastError: string): boolean {
    return (lastError.includes("timeout") || lastError.includes("timed out"))
  }  

  private shouldSkipError(error: unknown): boolean {
    // This error occurs when the transaction is replaced by a new one with a higher gas price - should be skipped
    return JSON.stringify(error).includes("TRANSACTION_REPLACED");
  }

  private async verifyExhausted(maxRetryAttempts: number | undefined, attempt: number, lastError: Error, nonceForThisTransaction: number | null, currentResult: { signedTx: string; txResponse?: TransactionResponse } | null): Promise<void> {
    if (maxRetryAttempts !== undefined && attempt > maxRetryAttempts) {
      throw new Error(`Failed to send transaction after ${maxRetryAttempts} attempts: ${lastError.message} with nonce ${nonceForThisTransaction} and tx hash ${currentResult?.txResponse?.hash}`);
    }
  }

  public readNonce(): number {
    return this.nonce ?? 0;
  }

  public forceNonceSync(): void {
    this.nonce = undefined;
  }

  private reportTimeoutError(telemetryFunctionCaller: TxTelemetryFunction, eventId: number, attempt: number, tx: Partial<TransactionRequest>, errorMessage: string): void {
    telemetryFunctionCaller(eventId, `transaction_error_timed_out_${attempt}`, this.chainId ?? 0, tx.to?.toString() ?? "", tx.nonce ?? 0, errorMessage);
    this.logger.warn("Transaction was not stuck in mempool, but timed out with no response", {chainId: this.chainId, nonce: tx.nonce, errorMessage: errorMessage});
  }

  /**
   * Sends a transaction with automatic retry and gas price adjustment for stuck transactions.
   * This function will:
   * 1. Send the transaction with initial gas settings
   * 2. Wait for confirmation with the specified timeout
   * 3. If the transaction gets stuck in mempool:
   *    - Retry with increased gas price using feeIncreaseFactor
   *    - Keep retrying with exponentially increasing gas until either:
   *      a) Transaction is confirmed
   *      b) Max attempts reached (if specified)
   *      c) Max gas price exceeded (if specified)
   *
   * @param tx - The transaction to send
   * @param config - Configuration options for the robust transaction sending
   * @param config.timeout - Time to wait for confirmation before retrying (ms) (default: 30000)
   * @param config.maxRetryAttempts - Maximum number of retry attempts (default: infinite)
   * @param config.feeIncreaseFactor - Multiply gas price by this factor on each retry (default: 1.11 - 11% increase)
   * In order to avoid the transaction being stuck in mempool, we increase the fee price by 11% on each retry
   * We must use at least 10% increase, for both fee values (maxFeePerGas and maxPriorityFeePerGas), 
   * Since the there is a rounding numbers error, we could miss the bare minimum fee to get the transaction included,
   * so we chose to use 11% increase, to be safe.
   * @param config.retryDelay - Initial delay between retries in ms (default: 1000)
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
    config: TxConfig = {},
    eventId: number = 0,
    telemetryFunction: TxTelemetryFunction | null = null
  ): Promise<{ signedTx: string; txResponse: TransactionResponse }> {
    const {
        timeout = 2*BLOCK_TIME,
        maxRetryAttempts = undefined,
        feeIncreaseFactor = 1.11,
        retryDelay = 0,
        retryDelayOnNetworkIssues = 250,
        confirmations = 1,
        useExponentialBackoff = true,
        maxDelayAllowed = 10000,
        exponentialBackoffExponent = 15
    } = config;

    let dynamicRetryDelay = retryDelay;

    // Should only be set if it was timed out, suspected as stuck in mempool
    let dynamicFeeIncreaseFactor = 1;
    let attempt = 1;
    let lastError: Error | null = null;
    let nonceForThisTransaction: number | null = null;
    let currentResult: { signedTx: string; txResponse?: TransactionResponse } | null = null;
    let isUserProvidedNonce = false;
    let prevFee: FeeData = { maxFeePerGas: undefined, maxPriorityFeePerGas: undefined, gasPrice: undefined};
    let hasBeenStuckInMempool = false;
    
    // If the nonce is provided by the user, use it
    if (tx.nonce !== undefined) {
      nonceForThisTransaction = tx.nonce;
      isUserProvidedNonce = true;
    }
    const telemetryFunctionCaller = (id: number, status: string, chainId: number, txTo: string, nonce: number, extraInfo: string) => {
      if (telemetryFunction && id !== 0) {
        telemetryFunction(id, status, chainId, txTo, nonce, extraInfo);
      }
    }


    telemetryFunctionCaller(eventId, `waiting_for_tx_limit_to_be_released`, this.chainId ?? 0, tx.to?.toString() ?? "", tx.nonce ?? 0, "");
    // We won't continue if we already have reached the max active transactions at once
    while (this.activeTxsCounter > this.maxTxsAtOnce) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    telemetryFunctionCaller(eventId, `tx_limit_was_released`, this.chainId ?? 0, tx.to?.toString() ?? "", tx.nonce ?? 0, "");

    
    try {
      this.activeTxsCounter += 1;
      while (maxRetryAttempts === undefined || attempt <= maxRetryAttempts + 1) {
          try {
              const prepareStatus = attempt > 1 ? `transaction_being_prepared_retry_${attempt}` : `transaction_being_prepared`;
              telemetryFunctionCaller(eventId, prepareStatus, this.chainId ?? 0, tx.to?.toString() ?? "", tx.nonce ?? 0, "");
              if (attempt > 1) {
                  // will be skipped if it is the very first attempt
                  // Prepare for retry attempts
                  // Start from multiplier of 1 (attempt = 2 multiplier = 1) and then grow exponentially
                  let backoffDelay = useExponentialBackoff ? dynamicRetryDelay * Math.pow(2, Math.ceil((attempt - 1) / exponentialBackoffExponent)) : dynamicRetryDelay;
                  if (maxDelayAllowed !== undefined && backoffDelay > maxDelayAllowed) {
                    backoffDelay = maxDelayAllowed;
                  }

                  // update the nonce for this transaction, only if it's not provided by the user and it's not null
                  if (!isUserProvidedNonce && nonceForThisTransaction !== null) {
                      tx.nonce = nonceForThisTransaction;
                  }

                  tx = await this.prepareForRetry(tx, backoffDelay, dynamicFeeIncreaseFactor, config.maxGasPrice, attempt - 1, prevFee);
              }
              

              const sendStatus = attempt > 1 ? `transaction_being_sent_retry_${attempt}` : `transaction_being_sent`;
              telemetryFunctionCaller(eventId, sendStatus, this.chainId ?? 0, tx.to?.toString() ?? "", tx.nonce ?? 0, "");
              
              // Send the transaction, writing the transaction to the mempool
              currentResult = await this._sendTransaction(tx, prevFee);

              if (currentResult.txResponse === undefined) {
                  throw new Error("Transaction was not broadcasted");
              }

              // Update nonce for this transaction
              nonceForThisTransaction = currentResult.txResponse.nonce;

              // Wait for confirmation with timeout
              await currentResult.txResponse.wait(confirmations, timeout);

              // Return the result on success
              if (attempt > 1) {
                this.logSuccessUnstuckedTx(currentResult.txResponse, false, eventId, telemetryFunction);
              } else {
                telemetryFunctionCaller(eventId, `transaction_succeeded_${attempt}_${currentResult.txResponse.hash}`, this.chainId ?? 0, tx.to?.toString() ?? "", tx.nonce ?? 0, "");
              }
              return currentResult as { signedTx: string; txResponse: TransactionResponse };
          } catch (e) {
            lastError = e as Error;

            let shouldResetStuckInMempoolIndicator = true;
            // When broadcasting we are getting more than one error message, we should only take the first one
            let getSingleErrMessage = (message: string) => {
              return message.substring(0, message.indexOf('}') + 1);
            }

            let errorMessage = e instanceof Error ? getSingleErrMessage(e.message): String(e);

            dynamicRetryDelay = retryDelay;
            dynamicFeeIncreaseFactor = 1;
            prevFee.lastErrorIsTimeout = false;
            if (this.shouldSkipError(errorMessage)) {
              const currResultInfo = currentResult?.txResponse ? `_${sha256(currentResult.txResponse.data)}` : "none";
              telemetryFunctionCaller(eventId, `transaction_error_skipped_${attempt}_${currResultInfo}`, this.chainId ?? 0, tx.to?.toString() ?? "", tx.nonce ?? 0, errorMessage);
              // For now we just collect telemetry, as soon as we are certain we should skip, we will
            }

            if (this.isTimeoutError(errorMessage)) {
              dynamicRetryDelay = retryDelayOnNetworkIssues;
              // Check if transaction is stuck in mempool
              this.logger.debug("Timeout error detected, checking if transaction might be stuck in mempool");
              prevFee.lastErrorIsTimeout = true;
              if (currentResult && currentResult.txResponse) {
                const txStatus = await this.checkTransactionStatus(currentResult.txResponse);
                if (txStatus === TransactionStatus.STUCK_IN_MEMPOOL) {
                  telemetryFunctionCaller(eventId, `transaction_error_stuck_in_mempool_${attempt}`, this.chainId ?? 0, tx.to?.toString() ?? "", tx.nonce ?? 0, errorMessage);
                  this.logger.warn("Transaction stuck in mempool, retrying with higher fee...", {chainId: this.chainId, nonce: tx.nonce});
                  dynamicFeeIncreaseFactor = feeIncreaseFactor;
                  dynamicRetryDelay = retryDelay;
                  hasBeenStuckInMempool = true;
                  shouldResetStuckInMempoolIndicator = false;
                } else if (txStatus === TransactionStatus.SUCCEEDED) {
                  // The transactin was managed to be sent, even though it was timed out, 
                  // Since we verified that the transaction was sent with the current result, we can return it
                  this.logger.info("Transaction succeeded already, returning current result", {chainId: this.chainId, nonce: tx.nonce, block: currentResult.txResponse.blockNumber});
                  this.logger.debug("Succeeded transaction is", {tx: tx})
                  this.logSuccessUnstuckedTx(currentResult.txResponse, false,eventId, telemetryFunction);
                  return currentResult as { signedTx: string; txResponse: TransactionResponse };
                } else {
                  this.reportTimeoutError(telemetryFunctionCaller, eventId, attempt, tx, errorMessage);
                }
              } else {
                this.reportTimeoutError(telemetryFunctionCaller, eventId, attempt, tx, errorMessage);
              }
            } else if (verifyNonceTooLow(errorMessage)) {
              telemetryFunctionCaller(eventId, `transaction_error_nonce_too_low_${attempt}`, this.chainId ?? 0, tx.to?.toString() ?? "", tx.nonce ?? 0, errorMessage);
              // Check if error indicates nonce too low, force nonce sync by setting nonce to null
              this.logger.warn("Nonce too low detected, forcing nonce sync...", {chainId: this.chainId, nonce: tx.nonce});
              this.nonce = undefined; // Force nonce sync
              tx.nonce = undefined; // Ignore user defined nonce
              nonceForThisTransaction = null;
            } else if (verifyNonceTooHigh(errorMessage)) {
              telemetryFunctionCaller(eventId, `transaction_error_nonce_too_high_${attempt}`, this.chainId ?? 0, tx.to?.toString() ?? "", tx.nonce ?? 0, errorMessage);
              this.logger.warn("Nonce too high detected, waiting longer before retry...", {chainId: this.chainId, error: e, nonce: tx.nonce});
              dynamicRetryDelay = 2 * retryDelayOnNetworkIssues;
            } else if (verifyReplacementFeeIssue(errorMessage)) {
              telemetryFunctionCaller(eventId, `transaction_error_replacement_fee_issue_${attempt}`, this.chainId ?? 0, tx.to?.toString() ?? "", tx.nonce ?? 0, errorMessage);
              // This case shouldn't happen, but if it does, we should log it
              this.logger.error("Replacement fee issue detected ", {chainId: this.chainId, error: e, nonce: tx.nonce, maxFeePerGas: tx.maxFeePerGas, priorityFee: tx.maxPriorityFeePerGas});
              if (!hasBeenStuckInMempool) {
                dynamicRetryDelay = 2 * retryDelayOnNetworkIssues;
                tx.nonce = undefined;
                nonceForThisTransaction = null;
                this.nonce = undefined;
              }
            } else if (isNetworkError(errorMessage)) {
              telemetryFunctionCaller(eventId, `transaction_error_network_${attempt}`, this.chainId ?? 0, tx.to?.toString() ?? "", tx.nonce ?? 0, errorMessage);
              dynamicRetryDelay = retryDelayOnNetworkIssues;
              // Handle network errors by waiting longer before retrying
              this.logger.warn("Network error detected, waiting longer before retry...", {chainId: this.chainId, error: e, nonce: tx.nonce});
            } else {
              telemetryFunctionCaller(eventId, `transaction_error_unknown_${attempt}`, this.chainId ?? 0, tx.to?.toString() ?? "", tx.nonce ?? 0, errorMessage);
              dynamicRetryDelay = retryDelayOnNetworkIssues;
              // Log stack trace for null/undefined errors to help with debugging
              if (e instanceof TypeError) {
                this.logger.debug("Stack trace for code error:", {error: e.stack});
              }

              this.logger.warn("", {
                chainId: this.chainId, 
                error: {
                  message: e instanceof Error ? e.message : String(e),
                  stack: e instanceof Error ? e.stack : undefined,
                  name: e instanceof Error ? e.name : undefined,
                  code: e instanceof Error ? (e as any).code : undefined
                },
                nonce: tx.nonce
              });
            }

            if (shouldResetStuckInMempoolIndicator) {
              hasBeenStuckInMempool = false;
            }
            
            // If we've exhausted our attempts, throw the last error, this should be handled by the requester
            this.verifyExhausted(maxRetryAttempts, attempt, lastError, nonceForThisTransaction, currentResult);          
            attempt++;
          }
      }
  } finally {
    this.activeTxsCounter -= 1;
  }
    throw lastError || new Error("Failed to send transaction");
  }

  private async prepareForRetry(tx: Partial<TransactionRequest>, backoffDelay: number, feeIncreaseFactor: number, maxGasPrice: bigint | undefined, retryCount: number, prevFee: FeeData): Promise<Partial<TransactionRequest>> {
    if (backoffDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
    
    // Calculate increase factor for better mempool acceptance
    let increaseFactor = Math.pow(feeIncreaseFactor, retryCount);
    // Then apply the gas increase on top of the validated transaction
    this.logger.debug("Applying fee increase factor", {gasPrice: tx.gasPrice, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas});
    tx = await this.applyFeeIncreaseFactor(tx, increaseFactor, prevFee); 

    // First validate the transaction with current gas prices, 
    // the prevFee here should not be used, since we already have gasLimit in retries
    this.logger.debug("Validating transaction with current gas fees", {gasPrice: tx.gasPrice, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas});
    tx = await this.validateFunds(tx, prevFee);
    

    // Check against max gas price if specified
    if (maxGasPrice) {
        const effectiveGasPrice = this.getEffectiveGasPrice(tx);
        if (effectiveGasPrice && effectiveGasPrice > maxGasPrice) {
            throw new Error("Gas price exceeded maximum allowed");
        }
    }

    if (increaseFactor > 1) {
      this.logger.warn(`Retrying transaction with ${increaseFactor}x gas price`, {attempt: retryCount + 1});
    } else {
      this.logger.debug(`Retrying transaction with ${increaseFactor}x gas price`, {attempt: retryCount + 1});
    }

    return tx;
  }

  private getBareMinFee(prevFee: number, retryMultiplier: number, newFee: number): number {
    const bareMinFee = prevFee * retryMultiplier; // the minimum fee that can be used to replace the previous attempt
    if (bareMinFee > newFee) {
      return bareMinFee;
    }
    return newFee;
  }

  /**
   * Helper function to clear and set gas price fields consistently
   * @param tx Transaction to update
   * @param feeData Fee data containing either EIP-1559 or legacy gas prices
   * @param prevFee Previous fee data
   * @param retryMultiplier Optional multiplier to apply to the fees
   */
  private setGasFees(
      tx: Partial<TransactionRequest>, 
      feeData: FeeData,
      prevFee: FeeData,
      retryMultiplier: number = 1,
  ): Partial<TransactionRequest> {
      // Clear existing gas fields
      delete tx.gasPrice;
      delete tx.maxFeePerGas;
      delete tx.maxPriorityFeePerGas;

      if (prevFee.maxFeePerGas !== undefined && prevFee.maxPriorityFeePerGas !== undefined && prevFee.gasPrice !== undefined) {
        this.logger.error("Somehow prevFee includes all fields", {prevFee});
      }

      // This meant to distinguish between retries
      // In order to avoid replacement transaction being sent with the exact same fee or below the previous one
      // Which may result in execution revert with the following error: "Known transaction" or 
      // Apply either EIP-1559 or legacy fees
      if ('maxFeePerGas' in feeData && feeData.maxFeePerGas !== undefined && feeData.maxPriorityFeePerGas !== undefined) {
        let maxFeePerGas = Math.floor(Number(feeData.maxFeePerGas) * retryMultiplier);
        let maxPriorityFeePerGas = Math.floor(Number(feeData.maxPriorityFeePerGas) * retryMultiplier);
      
        if (prevFee.maxFeePerGas !== undefined && prevFee.maxPriorityFeePerGas !== undefined && prevFee.lastErrorIsTimeout) {
          maxFeePerGas = this.getBareMinFee(Number(prevFee.maxFeePerGas), retryMultiplier, maxFeePerGas);
          maxPriorityFeePerGas = this.getBareMinFee(Number(prevFee.maxPriorityFeePerGas), retryMultiplier, maxPriorityFeePerGas);
        }

        tx.maxFeePerGas = BigInt(Math.ceil(maxFeePerGas));
        tx.maxPriorityFeePerGas = BigInt(Math.ceil(maxPriorityFeePerGas));
        this.logger.debug("After gas fees applied", {maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas});
        prevFee = {maxFeePerGas: BigInt(Math.ceil(maxFeePerGas)), maxPriorityFeePerGas: BigInt(Math.ceil(maxPriorityFeePerGas))};
      } else if ('gasPrice' in feeData && feeData.gasPrice !== undefined && feeData.gasPrice !== null) {
        let gasPrice = Math.floor(Number(feeData.gasPrice) * retryMultiplier);
        if (prevFee.gasPrice !== undefined && prevFee.lastErrorIsTimeout) {
          gasPrice = this.getBareMinFee(Number(prevFee.gasPrice), retryMultiplier, gasPrice);
        }
        tx.gasPrice = BigInt(Math.ceil(gasPrice));
        this.logger.debug("After gas fees applied", {gasPrice: tx.gasPrice});
        prevFee = {gasPrice: BigInt(Math.ceil(gasPrice))};
      }

      return tx;
  }

  private getEffectiveGasPrice(tx: Partial<TransactionRequest>): bigint | undefined {
    if (tx.maxFeePerGas) {
      return BigInt(tx.maxFeePerGas);
    } else if (tx.gasPrice) {
      return BigInt(tx.gasPrice);
    }
    return undefined;
  }
}
