import { Contract, ethers, TransactionRequest } from "ethers";
import { TransactionManager } from "../src/index";
import baseLogger from "./tools/logger.js";
import { Logger } from "winston";
import taskManager from "./TaskManager.json" assert { type: "json" };
import { fundAccount } from "./tools/fundAccount";


interface TransactionManagerConfigPublic {
    broadcast: boolean;
    defaultChain: string;
    chains: Record<string, any>;
    logger: Logger;
}
const logger = baseLogger.child({ module: "testManager" });


const txManagerConfig: TransactionManagerConfigPublic = {
    broadcast: true,
    defaultChain: "hardhat",
    chains: {
        "hardhat": {
            name: "hardhat",
            rpcUrl: "http://localhost:8545",
            wsUrl: "ws://localhost:8546",
            chainId: 420105,
            fheosIp: "127.0.0.1",
            fheosPort: 8449,
            privateKey: process.env.HARDHAT_PRIVATE_KEY,
        }
    },
    logger: logger
  }



const txManager = TransactionManager.fromDotEnv(txManagerConfig);

const requestors = ["0x55A07F9f7eD7F110c2Ddd8f2f5d8677Dc94aF4E2", "0x55A07F9f7eD7F110c2Ddd8f2f5d8677Dc94aF4E2"];
function genArgs(diff: number) {
  const temp = BigInt(`0x55A07F9f7eD7F110c2Ddd8f2f5d8677Dc94aF4E3`) + BigInt(diff);
  const temp2 = BigInt(`0x55A07F9f7eD7F110c2Ddd8f2f5d8677Dc94aF4E4`) + BigInt(diff);
  logger.info(`Generating args with diff ${diff}: ${temp.toString(16)}, ${temp2.toString(16)}`);
  return [temp, temp2, requestors];
}

async function forceNonceTooLowTx(
  tx: Partial<TransactionRequest>
): Promise<Partial<TransactionRequest>> {
  tx.nonce = 0; 
  return tx;
}

async function createHandleDecryptResultTx(
  contract: ethers.BaseContract,
  args: any[]
): Promise<Partial<TransactionRequest>> {
  return await contract
    .getFunction("handleDecryptResult")
    .populateTransaction(...args);
}
  

async function sendTx(
  tx: Partial<TransactionRequest>,
  txManager: TransactionManager, 
  diff: number,
  timeout: number = 1000
): Promise<void> {
  try {
    const telemetryFunctionCaller = (id: number, status: string, chainId: number, txTo: string, nonce: number) => {
      logger.info(`Telemetry: ${id} ${status} ${chainId} ${txTo} ${nonce}`);
    }
    
    const txResult = await txManager.sendTransaction(tx, {timeout: timeout, maxRetryAttempts: undefined}, 0, telemetryFunctionCaller, "hardhat"); // 10 ms timeout
    await txResult.txResponse?.wait();
    logger.info(`\x1b[32m[${diff}] Transaction sent! Hash: ${txResult.txResponse?.hash}\n\x1b[0m`);
  } catch (error) {
    // Format the error as JSON for better readability
    const errorStr = error instanceof Error 
      ? `${error.message}\n${JSON.stringify(error, null, 2)}`
      : JSON.stringify(error, null, 2);
    
    logger.error(`\x1b[31mError [${diff}] sending stuck tx: ${errorStr}\x1b[0m\n`);
  }
}

async function mineBlock(provider: ethers.JsonRpcProvider): Promise<void> {
  // using the RPC method evm_mine to mine a block
  logger.info("\x1b[95m-------------Mining a block-------------\x1b[0m");
  // wait for 5 seconds
  const pendingBlock = await provider.send("eth_getBlockByNumber", [
    "pending",
    false,
  ]);
  logger.info(`\x1b[95mPending block transactions: ${JSON.stringify(pendingBlock.transactions, null, 2)}\x1b[0m`);
  await provider.send("evm_mine", []);
}

async function testStuckTxs(contract: ethers.BaseContract, provider: ethers.JsonRpcProvider): Promise<void> {
  logger.info("Testing stuck txs");

  // create a tx with nonce 1 should fail with nonce too low, and then succeed
  let testCount = 0;
  logger.info(`\x1b[33m--------[${testCount}] Testing nonce too low--------\x1b[0m`);
  sendTx(
    await forceNonceTooLowTx(await createHandleDecryptResultTx(contract, genArgs(testCount))), 
    txManager, 
    testCount);
  await new Promise(resolve => setTimeout(resolve, 1000));
  await mineBlock(provider);

  // create a tx with low fee price should fail
  // Timeout is set to 1000ms, so it should fail quickly, meaning the tx will be released from the mempool
  // when the timeout is reached most of the time
  testCount++;
  logger.info(`\x1b[33m--------[${testCount}] Testing low fee price--------\x1b[0m`);
  sendTx(
    await createHandleDecryptResultTx(contract, genArgs(testCount)), 
    txManager, 
    testCount, 
    1000);

  await new Promise(resolve => setTimeout(resolve, 5000));
  await mineBlock(provider);

  // create a tx with low fee price should fail
  // Timeout is set to 10000ms, so it should not fail quickly, meaning the tx will be released from the mempool
  // before the timeout is reached most of the time
  testCount++;
  logger.info(`\x1b[33m--------[${testCount}] Testing low fee price--------\x1b[0m`);
  sendTx(
    await createHandleDecryptResultTx(contract, genArgs(testCount)), 
    txManager, 
    testCount, 
    10000);

  await new Promise(resolve => setTimeout(resolve, 5000));
  await mineBlock(provider);
  
}
  
async function main() {
    const chain = "hardhat";
    // get task manager contract
    const provider = new ethers.JsonRpcProvider(txManagerConfig.chains[chain].rpcUrl);
    const contract = new ethers.Contract(taskManager.address, taskManager.abi, provider);
    const wallet = new ethers.Wallet(txManagerConfig.chains[chain].privateKey, provider);
    const connectedContract = await contract.connect(wallet);

    // check balance
    const balance = await provider.getBalance(wallet.address);
    logger.info(`Balance: ${balance.toString()}`);

    // fund the wallet
    await fundAccount(wallet.address, txManagerConfig.chains[chain].rpcUrl, provider);
    
    // verify the TxManager can coop with stuck txs
    await testStuckTxs(connectedContract, provider);
}

main();
