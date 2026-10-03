use anchor_lang::prelude::*;

declare_id!("AgSfAvkXWBugaYg768AAZdpUT3oNYkx7JQGmZTrUwHWK");

#[program]
pub mod pacta {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
