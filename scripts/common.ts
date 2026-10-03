import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Commitment,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  RpcResponseAndContext,
  SignatureResult,
  SystemProgram,
  Transaction,
  TransactionConfirmationStrategy,
  TransactionExpiredBlockheightExceededError,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Pacta } from "../target/types/pacta";

export const ROOT = path.resolve(__dirname, "..");
export const KEYS_DIR = process.env.PACTA_KEYS_DIR ?? path.join(ROOT, ".keys");
export const DEMO_FILE = path.join(KEYS_DIR, "demo.json");
export const DECIMALS = 6;
export const CLUSTER = "devnet";

/** Demo wallets. Team order matters: allocations follow it. */
export const ROLES = ["client", "backend-dev", "frontend-dev", "designer", "arbiter"] as const;
export type Role = (typeof ROLES)[number];
export const TEAM: { name: Role; role: number; bps: number }[] = [
  { name: "backend-dev", role: 0, bps: 4_000 },
  { name: "frontend-dev", role: 1, bps: 3_500 },
  { name: "designer", role: 2, bps: 2_500 },
];

export const usdc = (n: number) => new BN(Math.round(n * 10 ** DECIMALS));

export function rpcUrl(): string {
  return process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
}

/**
 * Connection that confirms transactions by polling instead of websocket subscriptions.
 * Some RPC providers (e.g. Alchemy) do not support `signatureSubscribe`, which web3.js
 * (and therefore Anchor and spl-token helpers) relies on by default.
 */
export class PollingConnection extends Connection {
  async confirmTransaction(
    strategy: TransactionConfirmationStrategy | string,
    _commitment?: Commitment
  ): Promise<RpcResponseAndContext<SignatureResult>> {
    const signature = typeof strategy === "string" ? strategy : strategy.signature;
    const lastValidBlockHeight =
      typeof strategy !== "string" && "lastValidBlockHeight" in strategy ? strategy.lastValidBlockHeight : undefined;
    for (;;) {
      const { context, value } = await this.getSignatureStatuses([signature]);
      const status = value[0];
      if (status?.err) return { context, value: { err: status.err } };
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return { context, value: { err: null } };
      }
      if (lastValidBlockHeight !== undefined && (await this.getBlockHeight()) > lastValidBlockHeight) {
        throw new TransactionExpiredBlockheightExceededError(signature);
      }
      await sleep(500);
    }
  }
}

export const connect = () => new PollingConnection(rpcUrl(), "confirmed");

export function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

/** Loads `.keys/<name>.json`, creating it on first use. */
export function loadOrCreateKeypair(name: string): Keypair {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const file = path.join(KEYS_DIR, `${name}.json`);
  if (fs.existsSync(file)) return loadKeypair(file);
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

export function deployerKeypair(): Keypair {
  const file = process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");
  return loadKeypair(file);
}

export function getProgram(signer: Keypair): Program<Pacta> {
  const connection = connect();
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(signer), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/pacta.json"), "utf8"));
  return new Program<Pacta>(idl, provider);
}

export const projectPda = (programId: PublicKey, client: PublicKey, seed: BN) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("project"), client.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
    programId
  )[0];
export const milestonePda = (programId: PublicKey, project: PublicKey, index: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("milestone"), project.toBuffer(), Buffer.from([index])], programId)[0];
export const vaultPda = (programId: PublicKey, project: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), project.toBuffer()], programId)[0];

export const explorerAddress = (a: PublicKey | string) =>
  `https://explorer.solana.com/address/${a.toString()}?cluster=${CLUSTER}`;
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tops `to` up to `minSol`. Tries the devnet faucet with backoff first (it is often
 * rate limited), then falls back to a transfer from the deployer wallet.
 */
export async function ensureSol(connection: Connection, to: PublicKey, minSol: number, funder: Keypair) {
  const target = minSol * LAMPORTS_PER_SOL;
  let current = await connection.getBalance(to);
  if (current >= target) return;

  for (let attempt = 1; attempt <= 4 && current < target; attempt++) {
    try {
      const sig = await connection.requestAirdrop(to, Math.min(target - current, 2 * LAMPORTS_PER_SOL));
      await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) });
    } catch (e: any) {
      console.log(`  airdrop attempt ${attempt} failed: ${e?.message ?? e}`);
      await sleep(1_000 * 2 ** attempt);
    }
    current = await connection.getBalance(to);
  }
  if (current >= target) return;

  const missing = target - current;
  const funderBalance = await connection.getBalance(funder.publicKey);
  if (funderBalance < missing + 0.01 * LAMPORTS_PER_SOL) {
    throw new Error(
      `Cannot fund ${to.toBase58()}: faucet unavailable and deployer ${funder.publicKey.toBase58()} ` +
        `has only ${funderBalance / LAMPORTS_PER_SOL} SOL. Use https://faucet.solana.com and retry.`
    );
  }
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: missing })
  );
  await anchor.web3.sendAndConfirmTransaction(connection, tx, [funder]);
  console.log(`  funded ${to.toBase58()} with ${missing / LAMPORTS_PER_SOL} SOL from deployer`);
}

export type DemoState = {
  programId: string;
  mint: string;
  wallets: Record<string, string>;
  project?: { seed: string; address: string; vault: string; milestones: string[] };
};

export function readDemoState(): DemoState {
  if (!fs.existsSync(DEMO_FILE)) throw new Error("Missing .keys/demo.json. Run `yarn demo:setup` first.");
  return JSON.parse(fs.readFileSync(DEMO_FILE, "utf8"));
}

export function writeDemoState(state: DemoState) {
  fs.writeFileSync(DEMO_FILE, JSON.stringify(state, null, 2));
}
