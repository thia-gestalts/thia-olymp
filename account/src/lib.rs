//! The versioned OPAQUE profile shared by Thia's browser and server.
pub use opaque_ke::*;
pub use rand::rngs::OsRng;

pub struct Profile;

impl CipherSuite for Profile {
    type OprfCs = Ristretto255;
    type KeyExchange = TripleDh<Ristretto255, sha2::Sha512>;
    type Ksf = argon2::Argon2<'static>;
}

pub fn hardening() -> argon2::Argon2<'static> {
    argon2::Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon2::Params::new(19 * 1024, 2, 1, None).expect("valid OPAQUE profile"),
    )
}

#[cfg(target_arch = "wasm32")]
mod exchange;
