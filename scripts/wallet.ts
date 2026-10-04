/**
 * Test wallets on devnet, funded from the deployer (it pays the SOL and is the test USDC mint authority).
 *
 *   yarn wallet new <name> [--sol 0.1] [--usdc 0]      create .keys/<name>.json, fund it, print the key for Phantom
 *   yarn wallet fund <address|name> [--sol 0.1] [--usdc 0]   top up any wallet, e.g. one created in Phantom
 *   yarn wallet key <name>                             print the private key of .keys/<name>.json for Phantom
 *   yarn wallet list                                   every wallet in .keys/ with its SOL and USDC balance
 *
 * --sol tops the wallet UP TO that amount (no transfer if it already has enough); --usdc mints that many more.
 * Set ANCHOR_PROVIDER_URL to a private RPC (Helius, Alchemy): the public devnet endpoint rate-limits.
 */
import { utils } from "@coral-xyz/anchor";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import {
  connect,
  deployerKeypair,
  explorerAddress,
  KEYS_DIR,
  loadKeypair,
  loadOrCreateKeypair,
  readDemoState,
  rpcUrl,
  usdc,
} from "./common";

const connection = connect();
const deployer = deployerKeypair();
const mint = new PublicKey(readDemoState().mint);

function option(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(args[i + 1]);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`--${name} needs a non-negative number`);
  return value;
}

const keyFile = (name: string) => path.join(KEYS_DIR, `${name}.json`);

/** Address from a base58 string or the name of a wallet in .keys/. */
function resolveAddress(target: string): PublicKey {
  if (fs.existsSync(keyFile(target)))
    return loadKeypair(keyFile(target)).publicKey;
  try {
    return new PublicKey(target);
  } catch {
    throw new Error(
      `"${target}" is neither a wallet address nor a name in ${KEYS_DIR}`
    );
  }
}

async function topUpSol(to: PublicKey, sol: number) {
  const missing =
    Math.round(sol * LAMPORTS_PER_SOL) - (await connection.getBalance(to));
  if (missing <= 0) return;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: deployer.publicKey,
      toPubkey: to,
      lamports: missing,
    })
  );
  await sendAndConfirmTransaction(connection, tx, [deployer]);
}

async function mintUsdc(to: PublicKey, amount: number) {
  if (amount <= 0) return;
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    deployer,
    mint,
    to
  );
  await mintTo(
    connection,
    deployer,
    mint,
    ata.address,
    deployer,
    BigInt(usdc(amount).toString())
  );
}

async function balances(owner: PublicKey): Promise<string> {
  const sol = (await connection.getBalance(owner)) / LAMPORTS_PER_SOL;
  const tokens = await getAccount(
    connection,
    getAssociatedTokenAddressSync(mint, owner)
  )
    .then((a) => Number(a.amount) / 1e6)
    .catch(() => 0);
  return `${sol} SOL, ${tokens} USDC`;
}

async function fund(target: PublicKey, args: string[]) {
  await topUpSol(target, option(args, "sol", 0.1));
  await mintUsdc(target, option(args, "usdc", 0));
  console.log(
    `${target.toBase58()}: ${await balances(target)}\n${explorerAddress(
      target
    )}`
  );
}

const printKey = (kp: Keypair) =>
  console.log(
    `\nPrivate key for Phantom (Add / Connect Wallet → Import Private Key), devnet only:\n${utils.bytes.bs58.encode(
      kp.secretKey
    )}`
  );

async function main() {
  const [command, target, ...rest] = process.argv.slice(2);
  console.log(`RPC: ${rpcUrl()}`);

  switch (command) {
    case "new": {
      if (!target)
        throw new Error("Usage: yarn wallet new <name> [--sol 0.1] [--usdc 0]");
      const existed = fs.existsSync(keyFile(target));
      const kp = loadOrCreateKeypair(target);
      console.log(
        `${existed ? "Using existing" : "Created"} .keys/${target}.json`
      );
      await fund(kp.publicKey, rest);
      printKey(kp);
      return;
    }
    case "fund":
      if (!target)
        throw new Error(
          "Usage: yarn wallet fund <address|name> [--sol 0.1] [--usdc 0]"
        );
      return fund(resolveAddress(target), rest);
    case "key":
      if (!target || !fs.existsSync(keyFile(target)))
        throw new Error("Usage: yarn wallet key <name> (a file in .keys/)");
      return printKey(loadKeypair(keyFile(target)));
    case "list":
      for (const file of fs
        .readdirSync(KEYS_DIR)
        .filter(
          (f) =>
            f.endsWith(".json") && f !== "demo.json" && f !== "usdc-mint.json"
        )) {
        const kp = loadKeypair(path.join(KEYS_DIR, file));
        console.log(
          `${file
            .replace(/\.json$/, "")
            .padEnd(16)} ${kp.publicKey.toBase58()}  ${await balances(
            kp.publicKey
          )}`
        );
      }
      return;
    default:
      throw new Error(
        "Commands: new <name>, fund <address|name>, key <name>, list"
      );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
