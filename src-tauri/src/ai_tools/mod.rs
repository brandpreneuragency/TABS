//! Legacy AI command surface exposed to the AI sidebar.
//!
//! Registered commands resolve opaque process-local scope IDs through
//! [`crate::agent_tools::scope::WorkspaceScopeRegistry`]. They never accept a
//! model-supplied workspace root. `sandbox` remains only for its legacy tests.

pub mod cancel;
pub mod fs_ops;
pub mod git;
pub mod sandbox;
pub mod search;
pub mod shell;
