/**
 * One-off demo preparation on devnet (run the day before; the faucet is moody):
 * - keypairs in .keys/ for client, backend-dev, frontend-dev, designer, arbiter
 * - SOL for each of them (faucet with retry, deployer wallet as fallback)
 * - a test USDC mint (6 decimals) with 10 000 USDC on the client's ATA
 * - ATAs for every team member, so accept_milestone does not have to create them
 *
 * Usage: yarn demo:setup   (ANCHOR_PROVIDER_URL overrides the RPC, e.g. Helius)
 */
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection } from "@solana/web3.js";
import * as fs from "fs";
import {
  DECIMALS,
  deployerKeypair,
  DEMO_FILE,
  explorerAddress,
  ensureSol,
  getProgram,
  ROLES,
  rpcUrl,
  usdc,
  writeDemoState,
  loadOrCreateKeypair,
  DemoState,
} from "./common";

const CLIENT_USDC = 10_000;
const SOL_PER_ROLE: Record<string, number> = {
  client: 0.5,
  "backend-dev": 0.1,
  "frontend-dev": 0.1,
  designer: 0.1,
  arbiter: 0.1,
};

async function main() {
  const connection = new Connection(rpcUrl(), "confirmed");
  const deployer = deployerKeypair();
  const programId = getProgram(deployer).programId;
  console.log(`RPC: ${rpcUrl()}\nProgram: ${programId.toBase58()}\nDeployer: ${deployer.publicKey.toBase58()}\n`);

  const wallets = Object.fromEntries(ROLES.map((r) => [r, loadOrCreateKeypair(r)]));

  console.log("Funding wallets with SOL...");
  for (const role of ROLES) {
    await ensureSol(connection, wallets[role].publicKey, SOL_PER_ROLE[role], deployer);
    console.log(`  ${role.padEnd(13)} ${(await connection.getBalance(wallets[role].publicKey)) / 1e9} SOL`);
  }

  // Keep the mint address stable across runs: the backend and frontend configure it.
  const mintKeypair = loadOrCreateKeypair("usdc-mint");
  let mint = mintKeypair.publicKey;
  if (!(await connection.getAccountInfo(mint))) {
    console.log("\nCreating test USDC mint...");
    mint = await createMint(connection, deployer, deployer.publicKey, null, DECIMALS, mintKeypair);
  }

  console.log("Creating token accounts...");
  const atas: Record<string, string> = {};
  for (const role of ROLES) {
    const account = await getOrCreateAssociatedTokenAccount(connection, deployer, mint, wallets[role].publicKey);
    atas[role] = account.address.toBase58();
    if (role === "client" && account.amount < BigInt(usdc(CLIENT_USDC).toString())) {
      const missing = BigInt(usdc(CLIENT_USDC).toString()) - account.amount;
      await mintTo(connection, deployer, mint, account.address, deployer, missing);
      console.log(`  minted ${Number(missing) / 10 ** DECIMALS} USDC to client`);
    }
  }

  const previous: Partial<DemoState> = fs.existsSync(DEMO_FILE) ? JSON.parse(fs.readFileSync(DEMO_FILE, "utf8")) : {};
  writeDemoState({
    ...previous,
    programId: programId.toBase58(),
    mint: mint.toBase58(),
    wallets: Object.fromEntries(ROLES.map((r) => [r, wallets[r].publicKey.toBase58()])),
  });

  console.log("\nAddresses (saved to .keys/demo.json):");
  console.log(`  program       ${explorerAddress(programId)}`);
  console.log(`  USDC mint     ${explorerAddress(mint)}`);
  for (const role of ROLES) {
    console.log(`  ${role.padEnd(13)} ${explorerAddress(wallets[role].publicKey)}`);
    console.log(`  ${"".padEnd(13)} ATA ${explorerAddress(atas[role])}`);
  }
  console.log(`\nBackend .env:\n  PACTA_PROGRAM_ID=${programId.toBase58()}\n  PACTA_USDC_MINT=${mint.toBase58()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
