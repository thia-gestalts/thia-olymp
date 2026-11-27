use std::time::{Duration, Instant};

use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use base64::{Engine, engine::general_purpose::STANDARD};
use olymp_account::*;
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path, sync::Mutex};

use crate::Account;
use crate::{ApiError, ApiResult, AppState, now, random_token};

const SESSION_DAYS: i64 = 30;

pub(crate) fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub(crate) fn session_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

/// The signed-in account, or 401.
pub struct SignedIn(pub Account);

impl FromRequestParts<AppState> for SignedIn {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let token = session_token(&parts.headers).ok_or(ApiError::Unauthorized)?;
        state
            .db
            .session(&token_hash(token), now())?
            .map(SignedIn)
            .ok_or(ApiError::Unauthorized)
    }
}

pub(crate) fn same_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    if matches!(
        headers
            .get("sec-fetch-site")
            .and_then(|value| value.to_str().ok()),
        Some("cross-site" | "same-site")
    ) {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

async fn logout(
    State(state): State<AppState>,
    SignedIn(_): SignedIn,
    headers: HeaderMap,
) -> ApiResult<axum::http::StatusCode> {
    state.db.with(|db| {
        db.execute(
            "DELETE FROM sessions WHERE token_hash=?1",
            [token_hash(session_token(&headers).unwrap())],
        )
    })?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub struct OpaqueAuth {
    setup: ServerSetup<Profile>,
    pending: Mutex<HashMap<String, (Instant, Exchange)>>,
}

enum Exchange {
    Signup {
        id: String,
        name: String,
    },
    Login {
        id: Option<String>,
        generation: u32,
        login: ServerLogin<Profile>,
    },
}

impl OpaqueAuth {
    pub fn open(db: &crate::Db, data: &Path) -> Result<Self, String> {
        let path = data.join("opaque-setup-v1");
        let setup = match std::fs::read(&path) {
            Ok(bytes) => {
                ServerSetup::deserialize(&bytes).map_err(|_| "Invalid OPAQUE setup".to_owned())?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let enrolled = db
                    .with(|db| {
                        db.query_row(
                            "SELECT EXISTS(SELECT 1 FROM accounts WHERE opaque_record IS NOT NULL)",
                            [],
                            |row| row.get::<_, bool>(0),
                        )
                    })
                    .map_err(|e| e.to_string())?;
                if enrolled {
                    return Err("Restore opaque-setup-v1 before starting this database.".into());
                }
                let setup = ServerSetup::new(&mut OsRng);
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                use std::io::Write;
                let mut file = options.open(&path).map_err(|e| e.to_string())?;
                file.write_all(&setup.serialize())
                    .and_then(|_| file.sync_all())
                    .map_err(|e| e.to_string())?;
                setup
            }
            Err(error) => return Err(format!("{}: {error}", path.display())),
        };
        Ok(Self {
            setup,
            pending: Mutex::default(),
        })
    }

    fn put(&self, exchange: Exchange) -> ApiResult<String> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        pending.retain(|_, (created, _)| created.elapsed() < Duration::from_secs(120));
        let challenge = random_token(32);
        pending.insert(challenge.clone(), (Instant::now(), exchange));
        Ok(challenge)
    }

    fn take(&self, challenge: &str) -> ApiResult<Exchange> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(challenge)
            .filter(|(created, _)| created.elapsed() < Duration::from_secs(120))
            .map(|(_, exchange)| exchange)
            .ok_or(ApiError::Unauthorized)
    }
}

#[derive(Deserialize)]
struct Start {
    name: String,
    message: String,
}

#[derive(Deserialize)]
struct Finish {
    challenge: String,
    message: String,
    #[serde(default)]
    wrapped: String,
    #[serde(default)]
    device: String,
}

fn decode(message: &str) -> ApiResult<Vec<u8>> {
    STANDARD.decode(message).map_err(|_| ApiError::Unauthorized)
}

fn wrapped(value: &str) -> ApiResult<&str> {
    if decode(value)?.len() != 60 {
        return Err(ApiError::BadRequest("Invalid wrapped key.".into()));
    }
    Ok(value)
}

fn normalize(name: &str) -> ApiResult<String> {
    let name = name.trim().to_ascii_lowercase();
    if !(1..=64).contains(&name.len())
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.".contains(&c))
    {
        return Err(ApiError::BadRequest(
            "Use 1–64 letters, digits, dots, underscores or hyphens.".into(),
        ));
    }
    Ok(name)
}

fn registration(state: &AppState, name: &str, message: &str) -> ApiResult<String> {
    let request =
        RegistrationRequest::deserialize(&decode(message)?).map_err(|_| ApiError::Unauthorized)?;
    let result = ServerRegistration::start(&state.auth.setup, request, name.as_bytes())
        .map_err(|_| ApiError::Unauthorized)?;
    Ok(STANDARD.encode(result.message.serialize()))
}

fn record(message: &str) -> ApiResult<Vec<u8>> {
    let upload = RegistrationUpload::<Profile>::deserialize(&decode(message)?)
        .map_err(|_| ApiError::Unauthorized)?;
    Ok(ServerRegistration::finish(upload).serialize().to_vec())
}

type Credentials = (String, Vec<u8>, u32, String);

fn credentials(state: &AppState, name: &str) -> ApiResult<Option<Credentials>> {
    Ok(state.db.with(|db| db.query_row(
        "SELECT id, opaque_record, credential_generation, wrapped_key FROM accounts WHERE name = ?1 AND opaque_record IS NOT NULL",
        [name], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional())?)
}

async fn signup_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<Start>,
) -> ApiResult<Json<serde_json::Value>> {
    same_origin(&headers)?;
    if !state.signup {
        return Err(ApiError::SignupClosed);
    }
    let name = normalize(&req.name)?;
    let message = registration(&state, &name, &req.message)?;
    let id = random_token(16);
    let challenge = state.auth.put(Exchange::Signup {
        id: id.clone(),
        name,
    })?;
    Ok(Json(
        serde_json::json!({ "challenge": challenge, "id": id, "message": message }),
    ))
}

async fn signup_finish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<Finish>,
) -> ApiResult<axum::http::StatusCode> {
    same_origin(&headers)?;
    let Exchange::Signup { id, name } = state.auth.take(&req.challenge)? else {
        return Err(ApiError::Unauthorized);
    };
    let record = record(&req.message)?;
    let wrapped = wrapped(&req.wrapped)?;
    let changed = state.db.with(|db| db.execute(
        "INSERT INTO accounts (id, name, opaque_record, wrapped_key) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(name) DO NOTHING",
        params![id,name,record,wrapped],
    ))?;
    if changed == 0 {
        return Err(ApiError::Conflict(
            "Unable to create this account. Try signing in.".into(),
        ));
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}

fn begin_login(
    state: &AppState,
    name: &str,
    message: &str,
    found: Option<&Credentials>,
) -> ApiResult<(ServerLogin<Profile>, String)> {
    let record = found
        .map(|(_, bytes, _, _)| ServerRegistration::deserialize(bytes))
        .transpose()
        .map_err(|_| ApiError::Internal("Invalid stored credential".into()))?;
    let request =
        CredentialRequest::deserialize(&decode(message)?).map_err(|_| ApiError::Unauthorized)?;
    let result = ServerLogin::start(
        &mut OsRng,
        &state.auth.setup,
        record,
        request,
        name.as_bytes(),
        ServerLoginParameters::default(),
    )
    .map_err(|_| ApiError::Unauthorized)?;
    Ok((result.state, STANDARD.encode(result.message.serialize())))
}

fn verify(login: ServerLogin<Profile>, message: &str) -> ApiResult<()> {
    let message = CredentialFinalization::deserialize(&decode(message)?)
        .map_err(|_| ApiError::Unauthorized)?;
    login
        .finish(message, ServerLoginParameters::default())
        .map_err(|_| ApiError::Unauthorized)?;
    Ok(())
}

async fn login_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<Start>,
) -> ApiResult<Json<serde_json::Value>> {
    same_origin(&headers)?;
    let name = normalize(&req.name)?;
    let found = credentials(&state, &name)?;
    let (login, message) = begin_login(&state, &name, &req.message, found.as_ref())?;
    let (id, generation) = found.map_or((None, 0), |(id, _, generation, _)| (Some(id), generation));
    let challenge = state.auth.put(Exchange::Login {
        id,
        generation,
        login,
    })?;
    Ok(Json(
        serde_json::json!({ "challenge": challenge, "message": message }),
    ))
}

async fn login_finish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<Finish>,
) -> ApiResult<Response> {
    same_origin(&headers)?;
    let Exchange::Login {
        id,
        generation,
        login,
    } = state.auth.take(&req.challenge)?
    else {
        return Err(ApiError::Unauthorized);
    };
    verify(login, &req.message)?;
    let id = id.ok_or(ApiError::Unauthorized)?;
    let token = random_token(32);
    let expires = now() + SESSION_DAYS * 86400;
    if req.device.trim().is_empty() || req.device.len() > 120 {
        return Err(ApiError::BadRequest(
            "Missing or oversized device label".into(),
        ));
    }
    let wrapped = state.db.with(|db| {
        let tx = db.unchecked_transaction()?;
        let wrapped: Option<String> = tx.query_row(
            "SELECT wrapped_key FROM accounts WHERE id=?1 AND credential_generation=?2",
            params![id,generation], |row| row.get(0),
        ).optional()?;
        if wrapped.is_some() {
            tx.execute("INSERT INTO sessions (token_hash, account, expires, device) VALUES (?1,?2,?3,?4)", params![token_hash(&token),id,expires,req.device])?;
        }
        tx.commit()?;
        Ok(wrapped)
    })?.ok_or(ApiError::Unauthorized)?;
    let account = state
        .db
        .session(&token_hash(&token), now())?
        .ok_or(ApiError::Unauthorized)?;
    Ok(
        Json(serde_json::json!({"account":account,"token":token,"wrapped":wrapped}))
            .into_response(),
    )
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/signup/start", post(signup_start))
        .route("/signup/finish", post(signup_finish))
        .route("/login/start", post(login_start))
        .route("/login/finish", post(login_finish))
        .route("/logout", post(logout))
}
