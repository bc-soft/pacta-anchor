import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { Pacta } from "../target/types/pacta";

const DECIMALS = 6;
const usdc = (n: number) => new BN(Math.round(n * 10 ** DECIMALS));

describe("pacta", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.pacta as Program<Pacta>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let mint: PublicKey;
  const arbiter = Keypair.generate();
  const outsider = Keypair.generate();

  // ---------- helpers ----------

  const projectPda = (client: PublicKey, seed: BN) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("project"), client.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  const milestonePda = (project: PublicKey, index: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("milestone"), project.toBuffer(), Buffer.from([index])],
      program.programId
    )[0];
  const vaultPda = (project: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), project.toBuffer()], program.programId)[0];

  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner);
  const balance = async (account: PublicKey) => (await getAccount(connection, account)).amount;
  const status = (s: object) => Object.keys(s)[0];

  async function airdrop(to: PublicKey, sol = 2) {
    const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) });
  }

  /** New wallet with SOL and an ATA of the test mint. */
  async function wallet(): Promise<Keypair> {
    const kp = Keypair.generate();
    await airdrop(kp.publicKey);
    await createAssociatedTokenAccount(connection, payer, mint, kp.publicKey);
    return kp;
  }

  async function expectError(promise: Promise<unknown>, code: string) {
    try {
      await promise;
    } catch (e: any) {
      const actual = e?.error?.errorCode?.code ?? e?.message ?? String(e);
      expect(String(actual)).to.include(code);
      return;
    }
    expect.fail(`expected error ${code}`);
  }

  type Setup = {
    client: Keypair;
    members: Keypair[];
    project: PublicKey;
    vault: PublicKey;
    seed: BN;
  };

  async function createProject(opts: { members?: number; clientFunds?: number } = {}): Promise<Setup> {
    const client = await wallet();
    await mintTo(connection, payer, mint, ata(client.publicKey), payer, usdc(opts.clientFunds ?? 10_000).toNumber());
    const members: Keypair[] = [];
    for (let i = 0; i < (opts.members ?? 3); i++) members.push(await wallet());

    const seed = new BN(Math.floor(Math.random() * 2 ** 48));
    const project = projectPda(client.publicKey, seed);
    const vault = vaultPda(project);
    await program.methods
      .createProject(
        seed,
        mint,
        arbiter.publicKey,
        members.map((m, i) => ({ wallet: m.publicKey, role: i % 5 }))
      )
      .accountsPartial({
        client: client.publicKey,
        project,
        mint,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([client])
      .rpc();
    return { client, members, project, vault, seed };
  }

  function createMilestone(s: Setup, index: number, amount: BN, allocations: { wallet: PublicKey; bps: number }[]) {
    return program.methods
      .createMilestone(index, amount, allocations)
      .accountsPartial({
        client: s.client.publicKey,
        project: s.project,
        milestone: milestonePda(s.project, index),
        systemProgram: SystemProgram.programId,
      })
      .signers([s.client])
      .rpc();
  }

  function acceptContract(s: Setup, member: Keypair) {
    return program.methods
      .acceptContract()
      .accountsPartial({ member: member.publicKey, project: s.project })
      .signers([member])
      .rpc();
  }

  function fund(s: Setup, index: number, signer: Keypair = s.client) {
    return program.methods
      .fundMilestone(index)
      .accountsPartial({
        client: signer.publicKey,
        project: s.project,
        milestone: milestonePda(s.project, index),
        mint,
        clientAta: ata(signer.publicKey),
        vault: s.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();
  }

  function action(
    name: "startMilestone" | "submitMilestone" | "requestChanges" | "openDispute",
    s: Setup,
    index: number,
    signer: Keypair
  ) {
    return program.methods[name](index)
      .accountsPartial({ signer: signer.publicKey, project: s.project, milestone: milestonePda(s.project, index) })
      .signers([signer])
      .rpc();
  }

  const recipients = (wallets: PublicKey[]) =>
    wallets.map((w) => ({ pubkey: ata(w), isWritable: true, isSigner: false }));

  function acceptMilestone(
    s: Setup,
    index: number,
    opts: { signer?: Keypair; payees?: PublicKey[]; vault?: PublicKey } = {}
  ) {
    const signer = opts.signer ?? s.client;
    return program.methods
      .acceptMilestone(index)
      .accountsPartial({
        client: signer.publicKey,
        project: s.project,
        milestone: milestonePda(s.project, index),
        mint,
        vault: opts.vault ?? s.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(recipients(opts.payees ?? s.members.map((m) => m.publicKey)))
      .signers([signer])
      .rpc();
  }

  function resolveDispute(s: Setup, index: number, resolution: object, signer: Keypair = arbiter, payees?: PublicKey[]) {
    return program.methods
      .resolveDispute(index, resolution as any)
      .accountsPartial({
        arbiter: signer.publicKey,
        project: s.project,
        milestone: milestonePda(s.project, index),
        mint,
        vault: s.vault,
        client: s.client.publicKey,
        clientAta: ata(s.client.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(recipients(payees ?? s.members.map((m) => m.publicKey)))
      .signers([signer])
      .rpc();
  }

  function cancel(s: Setup, index: number) {
    return program.methods
      .cancelUnstartedMilestone(index)
      .accountsPartial({
        client: s.client.publicKey,
        project: s.project,
        milestone: milestonePda(s.project, index),
        mint,
        vault: s.vault,
        clientAta: ata(s.client.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([s.client])
      .rpc();
  }

  const split402535 = (s: Setup) => [
    { wallet: s.members[0].publicKey, bps: 4_000 },
    { wallet: s.members[1].publicKey, bps: 3_500 },
    { wallet: s.members[2].publicKey, bps: 2_500 },
  ];

  /** Project with one 1 000 USDC milestone (40/35/25), signed by everyone and funded. */
  async function fundedProject(): Promise<Setup> {
    const s = await createProject();
    await createMilestone(s, 0, usdc(1_000), split402535(s));
    for (const m of s.members) await acceptContract(s, m);
    await fund(s, 0);
    return s;
  }

  before(async () => {
    mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
    await airdrop(arbiter.publicKey);
    await airdrop(outsider.publicKey);
    await createAssociatedTokenAccount(connection, payer, mint, arbiter.publicKey);
    await createAssociatedTokenAccount(connection, payer, mint, outsider.publicKey);
  });

  // ---------- happy path (demo) ----------

  it("happy path: 1 000 USDC split 40/35/25 on acceptance", async () => {
    const s = await createProject();
    await createMilestone(s, 0, usdc(1_000), split402535(s));
    for (const m of s.members) await acceptContract(s, m);
    expect(status((await program.account.project.fetch(s.project)).status)).to.eq("active");

    await fund(s, 0);
    expect(await balance(s.vault)).to.eq(BigInt(usdc(1_000).toString()));
    expect(await balance(ata(s.client.publicKey))).to.eq(BigInt(usdc(9_000).toString()));

    await action("startMilestone", s, 0, s.members[0]);
    await action("submitMilestone", s, 0, s.members[1]);
    await acceptMilestone(s, 0);

    expect(await balance(ata(s.members[0].publicKey))).to.eq(BigInt(usdc(400).toString()));
    expect(await balance(ata(s.members[1].publicKey))).to.eq(BigInt(usdc(350).toString()));
    expect(await balance(ata(s.members[2].publicKey))).to.eq(BigInt(usdc(250).toString()));
    expect(await balance(s.vault)).to.eq(0n);

    const milestone = await program.account.milestone.fetch(milestonePda(s.project, 0));
    expect(status(milestone.status)).to.eq("paid");
    expect(status((await program.account.project.fetch(s.project)).status)).to.eq("completed");
  });

  // ---------- create / agree ----------

  it("rejects allocations that do not sum to 10 000 bps", async () => {
    const s = await createProject();
    await expectError(
      createMilestone(s, 0, usdc(100), [
        { wallet: s.members[0].publicKey, bps: 5_000 },
        { wallet: s.members[1].publicKey, bps: 4_000 },
      ]),
      "InvalidBpsSum"
    );
  });

  it("rejects an allocation to a wallet outside the team", async () => {
    const s = await createProject();
    await expectError(
      createMilestone(s, 0, usdc(100), [
        { wallet: s.members[0].publicKey, bps: 5_000 },
        { wallet: outsider.publicKey, bps: 5_000 },
      ]),
      "AllocationNotMember"
    );
  });

  it("rejects duplicate allocation wallets", async () => {
    const s = await createProject();
    await expectError(
      createMilestone(s, 0, usdc(100), [
        { wallet: s.members[0].publicKey, bps: 5_000 },
        { wallet: s.members[0].publicKey, bps: 5_000 },
      ]),
      "DuplicateAllocation"
    );
  });

  it("rejects an arbiter who is also a team member", async () => {
    const client = await wallet();
    const seed = new BN(1);
    const project = projectPda(client.publicKey, seed);
    await expectError(
      program.methods
        .createProject(seed, mint, arbiter.publicKey, [{ wallet: arbiter.publicKey, role: 0 }])
        .accountsPartial({ client: client.publicKey, project, mint, vault: vaultPda(project) })
        .signers([client])
        .rpc(),
      "ArbiterIsParty"
    );
  });

  it("accept_contract: outsiders rejected, project activates only after the last signature", async () => {
    const s = await createProject();
    await createMilestone(s, 0, usdc(100), split402535(s));

    await expectError(acceptContract(s, outsider), "Unauthorized");

    await acceptContract(s, s.members[0]);
    await acceptContract(s, s.members[1]);
    expect(status((await program.account.project.fetch(s.project)).status)).to.eq("draft");
    await expectError(acceptContract(s, s.members[0]), "AlreadyAccepted");

    await acceptContract(s, s.members[2]);
    const project = await program.account.project.fetch(s.project);
    expect(status(project.status)).to.eq("active");
    expect(project.members.every((m) => m.accepted)).to.eq(true);
  });

  it("freezes milestones once any member has signed", async () => {
    const s = await createProject();
    await createMilestone(s, 0, usdc(100), split402535(s));
    await acceptContract(s, s.members[0]);
    await expectError(createMilestone(s, 1, usdc(100), split402535(s)), "ContractAlreadySigned");
  });

  // ---------- fund ----------

  it("rejects funding before the project is active", async () => {
    const s = await createProject();
    await createMilestone(s, 0, usdc(100), split402535(s));
    await acceptContract(s, s.members[0]);
    await expectError(fund(s, 0), "InvalidStatus");
  });

  it("rejects funding by someone other than the client", async () => {
    const s = await createProject();
    await createMilestone(s, 0, usdc(100), split402535(s));
    for (const m of s.members) await acceptContract(s, m);
    await expectError(fund(s, 0, s.members[0]), "Unauthorized");
  });

  // ---------- accept / split ----------

  it("rejects accept_milestone signed by a member instead of the client", async () => {
    const s = await fundedProject();
    await action("submitMilestone", s, 0, s.members[0]);
    await expectError(acceptMilestone(s, 0, { signer: s.members[0] }), "Unauthorized");
  });

  it("rejects payout accounts that do not match allocations", async () => {
    const s = await fundedProject();
    await action("submitMilestone", s, 0, s.members[0]);
    const [a, b, c] = s.members.map((m) => m.publicKey);
    await expectError(acceptMilestone(s, 0, { payees: [b, a, c] }), "RecipientMismatch");
    await expectError(acceptMilestone(s, 0, { payees: [a, b] }), "InvalidRecipientAccounts");
    await expectError(acceptMilestone(s, 0, { payees: [a, b, outsider.publicKey] }), "RecipientMismatch");
    expect(await balance(s.vault)).to.eq(BigInt(usdc(1_000).toString()));
  });

  it("request_changes keeps funds in the vault and allows resubmission", async () => {
    const s = await fundedProject();
    await action("submitMilestone", s, 0, s.members[0]);
    await action("requestChanges", s, 0, s.client);

    let milestone = await program.account.milestone.fetch(milestonePda(s.project, 0));
    expect(status(milestone.status)).to.eq("changesRequested");
    expect(await balance(s.vault)).to.eq(BigInt(usdc(1_000).toString()));
    await expectError(action("requestChanges", s, 0, s.members[0]), "Unauthorized");

    await action("submitMilestone", s, 0, s.members[2]);
    milestone = await program.account.milestone.fetch(milestonePda(s.project, 0));
    expect(status(milestone.status)).to.eq("submitted");

    await acceptMilestone(s, 0);
    expect(await balance(s.vault)).to.eq(0n);
  });

  it("paid milestones are terminal", async () => {
    const s = await fundedProject();
    await action("submitMilestone", s, 0, s.members[0]);
    await acceptMilestone(s, 0);
    await expectError(acceptMilestone(s, 0), "InvalidStatus");
    await expectError(action("submitMilestone", s, 0, s.members[0]), "InvalidStatus");
    await expectError(cancel(s, 0), "InvalidStatus");
  });

  // ---------- disputes ----------

  it("dispute resolved Team75: team gets 750 by allocation, client 250", async () => {
    const s = await fundedProject();
    await action("submitMilestone", s, 0, s.members[0]);
    await action("openDispute", s, 0, s.members[1]);

    const milestone = await program.account.milestone.fetch(milestonePda(s.project, 0));
    expect(status(milestone.status)).to.eq("disputed");
    expect(milestone.dispute!.openedBy.toBase58()).to.eq(s.members[1].publicKey.toBase58());

    await expectError(resolveDispute(s, 0, { team75: {} }, outsider), "Unauthorized");
    await expectError(resolveDispute(s, 0, { team75: {} }, s.client), "Unauthorized");
    // Arbiter cannot route the team's share to themselves.
    await expectError(
      resolveDispute(s, 0, { team75: {} }, arbiter, [arbiter.publicKey, s.members[1].publicKey, s.members[2].publicKey]),
      "RecipientMismatch"
    );

    await resolveDispute(s, 0, { team75: {} });
    expect(await balance(ata(s.members[0].publicKey))).to.eq(BigInt(usdc(300).toString()));
    expect(await balance(ata(s.members[1].publicKey))).to.eq(BigInt(usdc(262.5).toString()));
    expect(await balance(ata(s.members[2].publicKey))).to.eq(BigInt(usdc(187.5).toString()));
    expect(await balance(ata(s.client.publicKey))).to.eq(BigInt(usdc(9_250).toString()));
    expect(await balance(s.vault)).to.eq(0n);
    expect(await balance(ata(arbiter.publicKey))).to.eq(0n);

    const resolved = await program.account.milestone.fetch(milestonePda(s.project, 0));
    expect(status(resolved.status)).to.eq("paid");
    expect(resolved.dispute!.resolution).to.deep.eq({ team75: {} });
  });

  it("dispute resolved Client100 refunds everything and cancels the milestone", async () => {
    const s = await fundedProject();
    await action("startMilestone", s, 0, s.members[0]);
    // Team started and went silent: the client can still escalate.
    await action("openDispute", s, 0, s.client);
    await resolveDispute(s, 0, { client100: {} }, arbiter, []);

    expect(await balance(ata(s.client.publicKey))).to.eq(BigInt(usdc(10_000).toString()));
    expect(await balance(s.vault)).to.eq(0n);
    const milestone = await program.account.milestone.fetch(milestonePda(s.project, 0));
    expect(status(milestone.status)).to.eq("cancelled");
  });

  it("disputes cannot be opened by outsiders or before work is delivered/started", async () => {
    const s = await fundedProject();
    await expectError(action("openDispute", s, 0, s.client), "InvalidStatus");
    await action("submitMilestone", s, 0, s.members[0]);
    await expectError(action("openDispute", s, 0, outsider), "Unauthorized");
  });

  // ---------- cancel ----------

  it("cancel_unstarted_milestone after funding refunds the client in full", async () => {
    const s = await fundedProject();
    expect(await balance(ata(s.client.publicKey))).to.eq(BigInt(usdc(9_000).toString()));
    await cancel(s, 0);
    expect(await balance(ata(s.client.publicKey))).to.eq(BigInt(usdc(10_000).toString()));
    expect(await balance(s.vault)).to.eq(0n);
    const milestone = await program.account.milestone.fetch(milestonePda(s.project, 0));
    expect(status(milestone.status)).to.eq("cancelled");
  });

  it("client cannot cancel once the team has started", async () => {
    const s = await fundedProject();
    await action("startMilestone", s, 0, s.members[0]);
    await expectError(cancel(s, 0), "InvalidStatus");
  });

  // ---------- escrow isolation ----------

  it("two projects in parallel keep their funds separate", async () => {
    const a = await fundedProject();
    const b = await fundedProject();
    await action("submitMilestone", a, 0, a.members[0]);
    await action("submitMilestone", b, 0, b.members[0]);

    // Project A cannot pay out of project B's vault.
    await expectError(acceptMilestone(a, 0, { vault: b.vault }), "ConstraintSeeds");

    await acceptMilestone(a, 0);
    expect(await balance(a.vault)).to.eq(0n);
    expect(await balance(b.vault)).to.eq(BigInt(usdc(1_000).toString()));
    expect(await balance(ata(b.members[0].publicKey))).to.eq(0n);
  });
});
