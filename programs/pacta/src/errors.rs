use anchor_lang::prelude::*;

#[error_code]
pub enum PactaError {
    #[msg("Signer is not allowed to perform this operation")]
    Unauthorized,
    #[msg("Account is not in a status that allows this operation")]
    InvalidStatus,
    #[msg("An arbiter is required")]
    ArbiterRequired,
    #[msg("Arbiter cannot be the client or a team member")]
    ArbiterIsParty,
    #[msg("Team must have between 1 and 8 members")]
    InvalidMemberCount,
    #[msg("Duplicate member wallet")]
    DuplicateMember,
    #[msg("Client cannot be a team member")]
    ClientIsMember,
    #[msg("Unknown member role")]
    InvalidRole,
    #[msg("Milestone index must equal the current milestone count")]
    InvalidMilestoneIndex,
    #[msg("Too many milestones")]
    TooManyMilestones,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Milestone must have between 1 and 8 allocations")]
    InvalidAllocationCount,
    #[msg("Allocations must sum to 10 000 bps")]
    InvalidBpsSum,
    #[msg("Allocation bps must be greater than zero")]
    ZeroBps,
    #[msg("Allocation wallet is not a team member")]
    AllocationNotMember,
    #[msg("Duplicate allocation wallet")]
    DuplicateAllocation,
    #[msg("A member has already signed the contract; milestones are frozen")]
    ContractAlreadySigned,
    #[msg("Member has already accepted the contract")]
    AlreadyAccepted,
    #[msg("Project has no milestones")]
    NoMilestones,
    #[msg("Token mint does not match the project mint")]
    MintMismatch,
    #[msg("Recipient token accounts must match allocations in count and order")]
    InvalidRecipientAccounts,
    #[msg("Recipient token account is not owned by the allocation wallet")]
    RecipientMismatch,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
