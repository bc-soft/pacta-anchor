/**
 * Live demo on devnet, one step per command so each transaction can be shown in Explorer:
 *
 *   yarn demo:flow create   client creates a project + 1 000 USDC milestone split 40/35/25
 *   yarn demo:flow agree    backend-dev, frontend-dev and designer sign the contract
 *   yarn demo:flow fund     client moves 1 000 USDC into the project vault
 *   yarn demo:flow submit   backend-dev starts and submits the milestone
 *   yarn demo:flow accept   client accepts -> program splits the payment 400/350/250
 *   yarn demo:flow all      every step above in sequence
 *   yarn demo:flow status   balances and statuses (also prints PDA fixtures for the backend)
 *
 * Requires `yarn demo:setup` first. State lives in .keys/demo.json.
 */
import { BN } from "@coral-xyz/anchor";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  DECIMALS,
  explorerAddress,
  explorerTx,
  getProgram,
  loadOrCreateKeypair,
  milestonePda,
  projectPda,
  readDemoState,
  TEAM,
  usdc,
  vaultPda,
  writeDemoState,
} from "./common";

const MILESTONE_INDEX = 0;
const MILESTONE_USDC = 1_000;

const state = readDemoState();
const mint = new PublicKey(state.mint);
const client = loadOrCreateKeypair("client");
const team = TEAM.map((t) => ({ ...t, keypair: loadOrCreateKeypair(t.name) }));
const arbiter = loadOrCreateKeypair("arbiter");
const programId = getProgram(client).programId;

function currentProject() {
  if (!state.project) throw new Error("No demo project yet. Run `yarn demo:flow create` first.");
  const project = new PublicKey(state.project.address);
  return { project, vault: vaultPda(programId, project), milestone: milestonePda(programId, project, MILESTONE_INDEX) };
}

const log = (step: string, sig: string) => console.log(`  ${step.padEnd(28)} ${explorerTx(sig)}`);

async function create() {
  const program = getProgram(client);
  const seed = new BN(Date.now());
  const project = projectPda(programId, client.publicKey, seed);
  const vault = vaultPda(programId, project);

  log(
    "create_project",
    await program.methods
      .createProject(
        seed,
        mint,
        arbiter.publicKey,
        team.map((t) => ({ wallet: t.keypair.publicKey, role: t.role }))
      )
      .accountsPartial({
        client: client.publicKey,
        project,
        mint,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  );

  const milestone = milestonePda(programId, project, MILESTONE_INDEX);
  log(
    "create_milestone",
    await program.methods
      .createMilestone(
        MILESTONE_INDEX,
        usdc(MILESTONE_USDC),
        team.map((t) => ({ wallet: t.keypair.publicKey, bps: t.bps }))
      )
      .accountsPartial({ client: client.publicKey, project, milestone, systemProgram: SystemProgram.programId })
      .rpc()
  );

  state.project = {
    seed: seed.toString(),
    address: project.toBase58(),
    vault: vault.toBase58(),
    milestones: [milestone.toBase58()],
  };
  writeDemoState(state);
  console.log(`  project ${explorerAddress(project)}`);
}

async function agree() {
  const { project } = currentProject();
  for (const t of team) {
    const program = getProgram(t.keypair);
    log(
      `accept_contract (${t.name})`,
      await program.methods.acceptContract().accountsPartial({ member: t.keypair.publicKey, project }).rpc()
    );
  }
}

async function fund() {
  const { project, vault, milestone } = currentProject();
  log(
    "fund_milestone",
    await getProgram(client)
      .methods.fundMilestone(MILESTONE_INDEX)
      .accountsPartial({
        client: client.publicKey,
        project,
        milestone,
        mint,
        clientAta: getAssociatedTokenAddressSync(mint, client.publicKey),
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc()
  );
}

async function submit() {
  const { project, milestone } = currentProject();
  const member = team[0].keypair;
  const program = getProgram(member);
  const accounts = { signer: member.publicKey, project, milestone };
  log("start_milestone", await program.methods.startMilestone(MILESTONE_INDEX).accountsPartial(accounts).rpc());
  log("submit_milestone", await program.methods.submitMilestone(MILESTONE_INDEX).accountsPartial(accounts).rpc());
}

async function accept() {
  const { project, vault, milestone } = currentProject();
  log(
    "accept_milestone",
    await getProgram(client)
      .methods.acceptMilestone(MILESTONE_INDEX)
      .accountsPartial({ client: client.publicKey, project, milestone, mint, vault, tokenProgram: TOKEN_PROGRAM_ID })
      .remainingAccounts(
        team.map((t) => ({
          pubkey: getAssociatedTokenAddressSync(mint, t.keypair.publicKey),
          isWritable: true,
          isSigner: false,
        }))
      )
      .rpc()
  );
}

async function status() {
  const program = getProgram(client);
  const { project, vault, milestone } = currentProject();
  const usdcOf = async (account: PublicKey) =>
    Number((await getAccount(program.provider.connection, account)).amount) / 10 ** DECIMALS;

  const p = await program.account.project.fetch(project);
  const m = await program.account.milestone.fetch(milestone);
  console.log(`  project   ${Object.keys(p.status)[0]}   ${explorerAddress(project)}`);
  console.log(`  milestone ${Object.keys(m.status)[0]}   ${explorerAddress(milestone)}`);
  console.log(`  vault     ${await usdcOf(vault)} USDC`);
  console.log(`  client    ${await usdcOf(getAssociatedTokenAddressSync(mint, client.publicKey))} USDC`);
  for (const t of team) {
    console.log(`  ${t.name.padEnd(9)} ${await usdcOf(getAssociatedTokenAddressSync(mint, t.keypair.publicKey))} USDC`);
  }
  console.log("\nBackend fixtures:");
  console.log(`  solana account ${project.toBase58()} --output json -u devnet > project.json`);
  console.log(`  solana account ${milestone.toBase58()} --output json -u devnet > milestone.json`);
}

const steps: Record<string, () => Promise<void>> = { create, agree, fund, submit, accept, status };

async function main() {
  const step = process.argv[2] ?? "status";
  const sequence = step === "all" ? ["create", "agree", "fund", "submit", "accept", "status"] : [step];
  for (const name of sequence) {
    if (!steps[name]) throw new Error(`Unknown step "${name}". Use: ${Object.keys(steps).join(", ")}, all`);
    console.log(`\n== ${name}`);
    await steps[name]();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
