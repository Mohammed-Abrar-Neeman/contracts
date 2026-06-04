// Deploys the Sepolia mock GSDC token (with EIP-3009).
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`[deploy-token] network=${network.name} deployer=${deployer.address}`);

  const Token = await ethers.getContractFactory("GSDCToken");
  const token = await Token.deploy(deployer.address);
  await token.waitForDeployment();
  const addr = await token.getAddress();
  console.log(`[deploy-token] GSDCToken deployed to ${addr}`);

  writeDeployment({ network: network.name, gsdcToken: addr, deployer: deployer.address });
}

function writeDeployment(entry: Record<string, string>) {
  const dir = path.resolve(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.network}.json`);
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  fs.writeFileSync(file, JSON.stringify({ ...prev, ...entry }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
