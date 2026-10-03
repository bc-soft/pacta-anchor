#![allow(ambiguous_glob_reexports)]

pub mod accept_contract;
pub mod accept_milestone;
pub mod cancel_unstarted_milestone;
pub mod create_milestone;
pub mod create_project;
pub mod fund_milestone;
pub mod milestone_status;
pub mod resolve_dispute;

// Glob re-exports are required by Anchor's #[program] macro (generated client modules).
// Every module exposes a `handler`; lib.rs always calls them by full path.
pub use accept_contract::*;
pub use accept_milestone::*;
pub use cancel_unstarted_milestone::*;
pub use create_milestone::*;
pub use create_project::*;
pub use fund_milestone::*;
pub use milestone_status::*;
pub use resolve_dispute::*;
