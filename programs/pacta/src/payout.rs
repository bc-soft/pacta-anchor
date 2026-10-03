//! Everything that moves tokens out of the vault lives here.
//! The vault's only authority is the project PDA, so these functions are the only
//! way funds can leave escrow, and they pay exclusively to allocation wallets or the client.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::PactaError;
use crate::events::PaymentDistributed;
use crate::state::{Allocation, Project, BPS_DENOMINATOR, PROJECT_SEED};

/// Splits `total` according to `allocations` (bps).
/// Each share is `total * bps / 10_000` rounded down; the rounding remainder
/// (at most `allocations.len() - 1` base units) goes to the last allocation,
/// so the whole amount is always paid out and the vault keeps nothing.
pub fn split(total: u64, allocations: &[Allocation]) -> Result<Vec<u64>> {
    let mut shares = Vec::with_capacity(allocations.len());
    let mut distributed: u64 = 0;
    for allocation in allocations {
        let share = (total as u128)
            .checked_mul(allocation.bps as u128)
            .and_then(|v| v.checked_div(BPS_DENOMINATOR as u128))
            .ok_or(PactaError::MathOverflow)?;
        let share = u64::try_from(share).map_err(|_| PactaError::MathOverflow)?;
        distributed = distributed.checked_add(share).ok_or(PactaError::MathOverflow)?;
        shares.push(share);
    }
    let remainder = total.checked_sub(distributed).ok_or(PactaError::MathOverflow)?;
    if let Some(last) = shares.last_mut() {
        *last = last.checked_add(remainder).ok_or(PactaError::MathOverflow)?;
    }
    Ok(shares)
}

/// Portion of `total` that goes to the team for a given bps, rounded down.
pub fn bps_of(total: u64, bps: u16) -> Result<u64> {
    let value = (total as u128)
        .checked_mul(bps as u128)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR as u128))
        .ok_or(PactaError::MathOverflow)?;
    u64::try_from(value).map_err(|_| error!(PactaError::MathOverflow))
}

/// Transfers `amount` from the project's vault, signing with the project PDA.
pub fn transfer_from_vault<'info>(
    project: &Account<'info, Project>,
    vault: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    token_program: &Program<'info, Token>,
    to: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seed_bytes = project.seed.to_le_bytes();
    let bump = [project.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[PROJECT_SEED, project.client.as_ref(), &seed_bytes, &bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to,
                authority: project.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        mint.decimals,
    )
}

/// Pays `total` to the team according to `allocations`.
/// `recipients` are the team's token accounts (from `remaining_accounts`), in allocation order.
/// Each must be a token account of the project mint owned by the allocation's wallet.
pub fn distribute_to_team<'info>(
    project: &Account<'info, Project>,
    milestone_key: Pubkey,
    vault: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    token_program: &Program<'info, Token>,
    recipients: &'info [AccountInfo<'info>],
    allocations: &[Allocation],
    total: u64,
) -> Result<()> {
    if total == 0 {
        return Ok(());
    }
    require_eq!(recipients.len(), allocations.len(), PactaError::InvalidRecipientAccounts);

    let shares = split(total, allocations)?;
    for ((allocation, info), share) in allocations.iter().zip(recipients.iter()).zip(shares) {
        require!(info.is_writable, PactaError::InvalidRecipientAccounts);
        // Deserializing as Account<TokenAccount> also checks the SPL Token program owns it.
        let recipient = Account::<TokenAccount>::try_from(info)?;
        require_keys_eq!(recipient.owner, allocation.wallet, PactaError::RecipientMismatch);
        require_keys_eq!(recipient.mint, project.mint, PactaError::MintMismatch);

        transfer_from_vault(project, vault, mint, token_program, info.clone(), share)?;
        emit!(PaymentDistributed {
            project: project.key(),
            milestone: milestone_key,
            wallet: allocation.wallet,
            amount: share,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alloc(bps: &[u16]) -> Vec<Allocation> {
        bps.iter()
            .map(|&bps| Allocation { wallet: Pubkey::new_unique(), bps })
            .collect()
    }

    #[test]
    fn splits_demo_case_exactly() {
        let shares = split(1_000_000_000, &alloc(&[4_000, 3_500, 2_500])).unwrap();
        assert_eq!(shares, vec![400_000_000, 350_000_000, 250_000_000]);
    }

    #[test]
    fn remainder_goes_to_last_member() {
        let shares = split(100, &alloc(&[3_333, 3_333, 3_334])).unwrap();
        assert_eq!(shares, vec![33, 33, 34]);
        assert_eq!(shares.iter().sum::<u64>(), 100);
    }

    #[test]
    fn never_overflows_on_max_amount() {
        let shares = split(u64::MAX, &alloc(&[5_000, 5_000])).unwrap();
        assert_eq!(shares.iter().map(|&s| s as u128).sum::<u128>(), u64::MAX as u128);
    }

    #[test]
    fn bps_of_rounds_down() {
        assert_eq!(bps_of(1_000, 7_500).unwrap(), 750);
        assert_eq!(bps_of(3, 5_000).unwrap(), 1);
        assert_eq!(bps_of(1_000, 0).unwrap(), 0);
    }
}
