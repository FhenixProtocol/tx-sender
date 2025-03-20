# tx-sender
like `ethers.send()` but more robust.

### Initialization
```typescript
import { TransactionManager } from "tx-sender";

const config = {
  broadcast: true,
  defaultChain: "ethereum",
  chains: {
    ethereum: {
      rpcUrl: "http://localhost:42069",
      chainId: 420105,
      privateKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
    },
    polygon: {
      rpcUrl: "http://localhost:8547",
      chainId: 420105,
      privateKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
    },
  },
};

const txManager = new TransactionManager(config);
```
 Or, the private keys could be supplied via a .env
```typescript
import { TransactionManager } from "tx-sender";

const config = {
  broadcast: true,
  defaultChain: "ethereum",
  chains: {
    ethereum: {
      rpcUrl: "http://localhost:42069",
      chainId: 420105,
    },
    polygon: {
      rpcUrl: "http://localhost:8547",
      chainId: 420105,
    },
  },
};

// .env:
// ETHEREUM_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000000
// POLYGON_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000000

const txManager = TransactionManager.fromDotEnv(config);
```

### Usage
Send many transactions in parallel. This will use a new nonce for every transaction.
```typescript
import { parseEther, parseUnits } from "ethers";

const tx = {
  to: "0x83dC5B863c48B95C77643071Cf60089b4C16d708",
  value: parseEther("0.0001"), // Convert ETH to Wei
  gasLimit: 42000, // Standard gas limit
  gasPrice: parseUnits("20", "gwei"), // Gas price
};

const promises = [];
promises.push(txManager.sendTransaction(tx, "ethereum"));
promises.push(txManager.sendTransaction(tx)); // uses default chain defined in config
promises.push(txManager.sendTransaction(tx, "polygon"));
promises.push(txManager.sendTransaction(tx, "ethereum"));
promises.push(txManager.sendTransaction(tx, "ethereum"));
promises.push(txManager.sendTransaction(tx, "polygon"));
promises.push(txManager.sendTransaction(tx, "polygon"));


await Promise.all(promises);
```

Contract interaction example
```typescript
import { ethers } from "ethers";

const CONTRACT_ADDRESS = "0xD050A6c223E999714bE8ce936E68570a3D684562";

// ABI: Replace this with your contract's actual ABI
const ABI = [
  {
    "inputs": [{
      "internalType": "uint64",
      "name": "newCounter",
      "type": "uint64"
    }],
    "name": "setPubCounter",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

// Create the contract object (no provider or signer needed)
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI);

// Call `getTransaction` for the function to prepare a transaction
const tx = await contract.setPubCounter.populateTransaction(42);

// optional, these will be populated automatically if not provided:
tx.gasLimit = 42000;
tx.gasPrice = parseUnits("20", "gwei");

await txManager.sendTransaction(tx, "ethereum");
```

### Testing

#### Setup 🛠️

1. Copy the environment files:
   ```zsh
   cp tests/.env.example tests/.env
   cp hardhat-eip1559/.env.example hardhat-eip1559/.env
   ```

2. Open a shell and run a hardhat node:
   ```zsh
   pnpm hardhat_node
   ```

2. Open another shell and run:
   ```zsh
   pnpm start
   ```

#### Notes on Test Output 📝

The tests use Hardhat to simulate stuck transactions by disabling auto-mining. This allows us to:

- 🔄 Manually trigger block mining on demand
- 🌸 Observe "stuck" transactions in the pending block (<span style="color:pink">shown in pink</span>)
- 🟢 See successfully mined transactions (<span style="color:green">shown in green</span>)
- ✅ Verify in the node shell when blocks are mined with the desired transactions
