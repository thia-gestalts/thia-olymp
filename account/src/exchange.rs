use crate::{
    ClientLogin, ClientLoginFinishParameters, ClientRegistration,
    ClientRegistrationFinishParameters, CredentialResponse, OsRng, Profile, RegistrationResponse,
    hardening,
};
use wasm_bindgen::prelude::*;

fn invalid(_: impl core::fmt::Debug) -> JsError {
    JsError::new("Unable to complete sign-in.")
}

#[wasm_bindgen]
#[derive(Default)]
pub struct PasswordExchange {
    login: Option<ClientLogin<Profile>>,
    registration: Option<ClientRegistration<Profile>>,
}

#[wasm_bindgen]
impl PasswordExchange {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(&mut self, password: &[u8], register: bool) -> Result<Vec<u8>, JsError> {
        if register {
            let start =
                ClientRegistration::<Profile>::start(&mut OsRng, password).map_err(invalid)?;
            self.registration = Some(start.state);
            Ok(start.message.serialize().to_vec())
        } else {
            let start = ClientLogin::<Profile>::start(&mut OsRng, password).map_err(invalid)?;
            self.login = Some(start.state);
            Ok(start.message.serialize().to_vec())
        }
    }

    pub fn finish(
        &mut self,
        password: &[u8],
        response: &[u8],
        register: bool,
    ) -> Result<JsValue, JsError> {
        let ksf = hardening();
        let (message, export_key) = if register {
            let state = self
                .registration
                .take()
                .ok_or_else(|| JsError::new("Start registration first."))?;
            let result = state
                .finish(
                    &mut OsRng,
                    password,
                    RegistrationResponse::deserialize(response).map_err(invalid)?,
                    ClientRegistrationFinishParameters::new(Default::default(), Some(&ksf)),
                )
                .map_err(invalid)?;
            (
                result.message.serialize().to_vec(),
                result.export_key.to_vec(),
            )
        } else {
            let state = self
                .login
                .take()
                .ok_or_else(|| JsError::new("Start sign-in first."))?;
            let result = state
                .finish(
                    &mut OsRng,
                    password,
                    CredentialResponse::deserialize(response).map_err(invalid)?,
                    ClientLoginFinishParameters::new(None, Default::default(), Some(&ksf)),
                )
                .map_err(invalid)?;
            (
                result.message.serialize().to_vec(),
                result.export_key.to_vec(),
            )
        };
        let parts = js_sys::Array::new();
        parts.push(&js_sys::Uint8Array::from(message.as_slice()));
        parts.push(&js_sys::Uint8Array::from(export_key.as_slice()));
        Ok(parts.into())
    }
}
