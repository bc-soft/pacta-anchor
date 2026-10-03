use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::PactaError;
use crate::events::ProjectCreated;
use crate::state::*;

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct CreateProject<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(
        init,
        payer = client,
        space = 8 + Project::INIT_SPACE,
        seeds = [PROJECT_SEED, client.key().as_ref(), &seed.to_le_bytes()],
        bump,
    )]
    pub project: Account<'info, Project>,

    pub mint: Account<'info, Mint>,

    /// Escrow for the whole project. Its only authority is the project PDA,
    /// so no wallet (including the client and the program author) can move funds directly.
    #[account(
        init,
        payer = client,
        seeds = [VAULT_SEED, project.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = project,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateProject>,
    seed: u64,
    mint: Pubkey,
    arbiter: Option<Pubkey>,
    members: Vec<MemberInput>,
) -> Result<()> {
    let client = ctx.accounts.client.key();
    require_keys_eq!(mint, ctx.accounts.mint.key(), PactaError::MintMismatch);

    // MVP: disputes must always be possible, so an arbiter is mandatory.
    let arbiter_key = arbiter.ok_or(PactaError::ArbiterRequired)?;
    require_keys_neq!(arbiter_key, client, PactaError::ArbiterIsParty);

    require!(
        !members.is_empty() && members.len() <= MAX_MEMBERS,
        PactaError::InvalidMemberCount
    );
    for (i, member) in members.iter().enumerate() {
        require!(member.role <= MAX_ROLE, PactaError::InvalidRole);
        require_keys_neq!(member.wallet, client, PactaError::ClientIsMember);
        // An arbiter who is also a payee could award funds to themselves.
        require_keys_neq!(member.wallet, arbiter_key, PactaError::ArbiterIsParty);
        require!(
            !members[..i].iter().any(|m| m.wallet == member.wallet),
            PactaError::DuplicateMember
        );
    }

    let project = &mut ctx.accounts.project;
    project.client = client;
    project.seed = seed;
    project.mint = mint;
    project.arbiter = Some(arbiter_key);
    project.status = ProjectStatus::Draft;
    project.members = members
        .iter()
        .map(|m| Member { wallet: m.wallet, role: m.role, accepted: false })
        .collect();
    project.milestone_count = 0;
    project.bump = ctx.bumps.project;
    project.closed_milestone_count = 0;

    emit!(ProjectCreated {
        project: project.key(),
        client,
        mint,
        arbiter: project.arbiter,
        member_count: project.members.len() as u8,
    });
    Ok(())
}
