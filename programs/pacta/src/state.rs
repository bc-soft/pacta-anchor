use anchor_lang::prelude::*;

use crate::errors::PactaError;

// PDA seeds. The backend derives the same addresses, so these must never change:
// project   = ["project",   client, seed.to_le_bytes()]
// milestone = ["milestone", project, [index]]
// vault     = ["vault",     project]
pub const PROJECT_SEED: &[u8] = b"project";
pub const MILESTONE_SEED: &[u8] = b"milestone";
pub const VAULT_SEED: &[u8] = b"vault";

pub const BPS_DENOMINATOR: u16 = 10_000;
pub const MAX_MEMBERS: usize = 8;
pub const MAX_ROLE: u8 = 4;

// Enum variants are encoded as u8 in declaration order and decoded by the backend.
// Never reorder them; only append new variants at the end.

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ProjectStatus {
    Draft,
    Active,
    Completed,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MilestoneStatus {
    Draft,
    Funded,
    InProgress,
    Submitted,
    ChangesRequested,
    Disputed,
    Paid,
    Cancelled,
}

/// Closed list of arbiter decisions: how much of the milestone goes to the team.
/// The rest is refunded to the client.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Resolution {
    Team100,
    Team75,
    Team50,
    Team25,
    Client100,
}

impl Resolution {
    pub fn team_bps(self) -> u16 {
        match self {
            Resolution::Team100 => 10_000,
            Resolution::Team75 => 7_500,
            Resolution::Team50 => 5_000,
            Resolution::Team25 => 2_500,
            Resolution::Client100 => 0,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Project {
    pub client: Pubkey,
    pub seed: u64,
    pub mint: Pubkey,
    pub arbiter: Option<Pubkey>,
    pub status: ProjectStatus,
    #[max_len(8)]
    pub members: Vec<Member>,
    pub milestone_count: u8,
    pub bump: u8,
    /// Milestones in a terminal state (Paid or Cancelled). Project becomes Completed
    /// when every milestone is closed.
    pub closed_milestone_count: u8,
}

impl Project {
    pub fn is_member(&self, wallet: &Pubkey) -> bool {
        self.members.iter().any(|m| m.wallet == *wallet)
    }

    pub fn require_member(&self, wallet: &Pubkey) -> Result<()> {
        require!(self.is_member(wallet), PactaError::Unauthorized);
        Ok(())
    }

    pub fn require_client(&self, wallet: &Pubkey) -> Result<()> {
        require_keys_eq!(self.client, *wallet, PactaError::Unauthorized);
        Ok(())
    }

    pub fn any_accepted(&self) -> bool {
        self.members.iter().any(|m| m.accepted)
    }

    pub fn all_accepted(&self) -> bool {
        self.members.iter().all(|m| m.accepted)
    }

    /// Marks one milestone as terminal; completes the project once all are terminal.
    pub fn close_milestone(&mut self) -> Result<()> {
        self.closed_milestone_count = self
            .closed_milestone_count
            .checked_add(1)
            .ok_or(PactaError::MathOverflow)?;
        if self.status == ProjectStatus::Active && self.closed_milestone_count == self.milestone_count {
            self.status = ProjectStatus::Completed;
        }
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Member {
    pub wallet: Pubkey,
    /// 0 backend, 1 frontend, 2 design, 3 qa, 4 other. Label only.
    pub role: u8,
    pub accepted: bool,
}

/// Input for `create_project`: a member before signing the contract.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MemberInput {
    pub wallet: Pubkey,
    pub role: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Milestone {
    pub project: Pubkey,
    pub index: u8,
    /// In the smallest token units (USDC: 6 decimals).
    pub amount: u64,
    pub status: MilestoneStatus,
    /// Sum of bps == 10 000, every wallet is a project member, immutable after creation.
    #[max_len(8)]
    pub allocations: Vec<Allocation>,
    pub dispute: Option<Dispute>,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Allocation {
    pub wallet: Pubkey,
    pub bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Dispute {
    pub opened_by: Pubkey,
    /// None = dispute still open.
    pub resolution: Option<Resolution>,
}
