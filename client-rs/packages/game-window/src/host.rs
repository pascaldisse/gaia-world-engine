//! Exactly one Host implementation is compiled in (see Cargo.toml features). Same 4-method surface either way.
#[cfg(all(feature = "host-ipc", feature = "stub-host"))]
compile_error!("features host-ipc and stub-host are mutually exclusive (no silent fallback): --no-default-features --features host-ipc");
#[cfg(not(any(feature = "host-ipc", feature = "stub-host")))]
compile_error!("enable exactly one of: stub-host (default) | host-ipc");

#[cfg(feature = "stub-host")]
pub use crate::host_stub::HostAdapter;

#[cfg(all(feature = "host-ipc", not(feature = "stub-host")))]
pub use crate::host_ipc::HostAdapter;
