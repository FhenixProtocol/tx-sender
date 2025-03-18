import { Contract, ethers, TransactionRequest } from "ethers";
import { TransactionManager } from "./src/index";
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
        // "localfhenix": {
        //     name: "localfhenix",
        //     rpcUrl: "http://localhost:42069",
        //     wsUrl: "ws://localhost:42070",
        //     chainId: 420105,
        //     fheosIp: "127.0.0.1",
        //     fheosPort: 8449,
        //     feeMultiplier: BigInt(5) / BigInt(10)
        // }
        "hardhat": {
            name: "hardhat",
            rpcUrl: "http://localhost:8545",
            wsUrl: "ws://localhost:8546",
            chainId: 420105,
            fheosIp: "127.0.0.1",
            fheosPort: 8449,
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
  diff: number
): Promise<void> {
  try {
    const txResult = await txManager.sendTransaction(tx, {timeout: 10000, maxRetryAttempts: 100}, "hardhat"); // 10 ms timeout
    await txResult.txResponse?.wait();
    logger.info(`[${diff}] Transaction sent! Hash: ${txResult.txResponse?.hash}`);
  } catch (error) {
    // Format the error as JSON for better readability
    const errorStr = error instanceof Error 
      ? `${error.message}\n${JSON.stringify(error, null, 2)}`
      : JSON.stringify(error, null, 2);
    
    logger.error(`Error [${diff}] sending stuck tx: ${errorStr}`);
  }
}

async function mineBlock(provider: ethers.JsonRpcProvider): Promise<void> {
  // using the RPC method evm_mine to mine a block
  logger.info("--------Testing evm_mine--------");
  // wait for 5 seconds
  const pendingBlock = await provider.send("eth_getBlockByNumber", [
    "pending",
    false,
  ]);
  logger.info(`Pending block: ${pendingBlock}`);
  await provider.send("evm_mine", []);
  logger.info("-------------------------------------\n\n\n");
}

async function testStuckTxs(contract: ethers.BaseContract, provider: ethers.JsonRpcProvider): Promise<void> {
  logger.info("Testing stuck txs");

  // create a tx with nonce 1 should fail with nonce too low, and then succeed
  logger.info("--------Testing nonce too low--------");
  const firstTest = 0;
  const tx = await forceNonceTooLowTx(await createHandleDecryptResultTx(contract, genArgs(firstTest)));
  sendTx(tx, txManager, firstTest);
  await new Promise(resolve => setTimeout(resolve, 1000));
  await mineBlock(provider);
  logger.info("-------------------------------------\n\n\n");

  // create a tx with low gas price should fail
  logger.info("--------Testing low gas price--------");
  const secondTest = 1;
  const tx2 = await createHandleDecryptResultTx(contract, genArgs(secondTest));
  sendTx(tx2, txManager, secondTest);
  logger.info("-------------------------------------\n\n\n");

  await new Promise(resolve => setTimeout(resolve, 10000));
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
    if (chain === "localfhenix") {
      await fundAccount(wallet.address, txManagerConfig.chains[chain].rpcUrl, provider);
    }
    
    // verify the TxManager can coop with stuck txs
    await testStuckTxs(connectedContract, provider);
}

main();
