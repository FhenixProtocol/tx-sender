import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("Mining Blocks", function () {
  it("should detect network and mine a block", async function () {
    console.log(`Mining on network: ${network.name}`);
    console.log(`Network chainId: ${network.config.chainId}`);
    console.log(`Network URL: ${network.config.url || "local hardhat network"}`);
    
    // Check if we're on a real network
    if (network.name !== "hardhat" && network.name !== "localhost") {
      console.log("Detected external network, using appropriate mining method");
      
      // For most external networks, we might need to submit a transaction
      // but some testnets still support evm_mine
      try {
        // Try the evm_mine method first (works on most development/test nodes)
        await network.provider.send("evm_mine", []);
        console.log("Successfully mined a block using evm_mine");
      } catch (error) {
        console.log("evm_mine not supported, sending a small transaction to mine a block");
        
        // Get a signer
        const [signer] = await ethers.getSigners() as SignerWithAddress[];
        console.log(`Using signer: ${signer.address}`);
        
        // Send a small transaction to force a block to be mined
        const tx = await signer.sendTransaction({
          to: signer.address,
          value: ethers.parseEther("0.0001"),
          gasLimit: 21000,
        });
        
        await tx.wait();
        console.log(`Transaction mined in block: ${await ethers.provider.getBlockNumber()}`);
        console.log(`Transaction hash: ${tx.hash}`);
      }
    } else {
      // For hardhat/localhost, use standard evm_mine
      await network.provider.send("evm_mine", []);
      console.log("Block mined on local network");
    }
  });
}); 