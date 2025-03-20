### Tx-Sender Testing

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

#### Debugging 🔍

The project includes VS Code debugging configurations in the `.vscode` folder. To start debugging:

1. Open the project in VS Code
2. Press F5 or select "Run and Debug" from the sidebar
3. Choose the appropriate debug configuration

This allows you to:
- Set breakpoints
- Step through code execution
- Inspect variables and state
- Debug the transaction sending process in real-time
