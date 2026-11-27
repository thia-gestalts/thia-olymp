use crate::{
    auth::{SignedIn, session_token, token_hash},
    *,
};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::HeaderMap,
    routing::post,
};
use base64::engine::general_purpose::STANDARD;
use rusqlite::params;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

fn scope(account: &Account, h: &HeaderMap) -> ApiResult<()> {
    if h.get("x-olymp-account").and_then(|v| v.to_str().ok()) == Some(&account.id) {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}
fn current(db: &Connection, id: &str) -> rusqlite::Result<u64> {
    db.query_row("SELECT revision FROM bases WHERE account=?", [id], |r| {
        r.get(0)
    })
    .optional()
    .map(|r| r.unwrap_or(0))
}
#[derive(Serialize, Default)]
struct Snapshot {
    revision: u64,
    envelope: Option<String>,
}
async fn read(
    State(s): State<AppState>,
    SignedIn(a): SignedIn,
    h: HeaderMap,
) -> ApiResult<Json<Snapshot>> {
    scope(&a, &h)?;
    let base = s.db.with(|db| {
        db.query_row(
            "SELECT revision,envelope FROM bases WHERE account=?",
            [a.id],
            |row| {
                Ok(Snapshot {
                    revision: row.get(0)?,
                    envelope: row.get(1)?,
                })
            },
        )
        .optional()
    })?;
    Ok(Json(base.unwrap_or_default()))
}
#[derive(Deserialize)]
struct Write {
    revision: u64,
    envelope: String,
    chunks: BTreeSet<String>,
}
async fn write(
    State(s): State<AppState>,
    SignedIn(a): SignedIn,
    h: HeaderMap,
    Json(w): Json<Write>,
) -> ApiResult<Json<u64>> {
    scope(&a, &h)?;
    if STANDARD.decode(&w.envelope).map_or(true, |v| v.len() < 40) {
        return Err(ApiError::BadRequest("Invalid envelope".into()));
    }
    let db = s.db.0.lock().unwrap();
    let tx = db.unchecked_transaction()?;
    if current(&tx, &a.id)? != w.revision {
        return Err(ApiError::Conflict("Revision changed".into()));
    }
    let next = w.revision + 1;
    tx.execute(
        "UPDATE chunks SET staged=?2 WHERE account=?1 AND staged IS NULL",
        params![a.id, now()],
    )?;
    for id in &w.chunks {
        if tx.execute(
            "UPDATE chunks SET staged=NULL WHERE account=? AND id=?",
            params![a.id, id],
        )? == 0
        {
            return Err(ApiError::Conflict("Upload missing chunks".into()));
        }
    }
    tx.execute(
        "INSERT INTO bases VALUES(?,?,?) ON CONFLICT(account) DO UPDATE SET
         revision=excluded.revision,envelope=excluded.envelope",
        params![a.id, next, w.envelope],
    )?;
    tx.commit()?;
    Ok(Json(next))
}
async fn upload(
    State(s): State<AppState>,
    SignedIn(a): SignedIn,
    h: HeaderMap,
    Path(id): Path<String>,
    bytes: Bytes,
) -> ApiResult<StatusCode> {
    scope(&a, &h)?;
    if bytes.len() < 40 || format!("{:x}", Sha256::digest(&bytes)) != id {
        return Err(ApiError::BadRequest("Chunk digest mismatch".into()));
    }
    let db = s.db.0.lock().unwrap();
    let tx = db.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM chunks WHERE account=? AND staged<?",
        params![a.id, now() - 86400],
    )?;
    tx.execute(
        "INSERT INTO chunks VALUES(?,?,?,?) ON CONFLICT(account,id) DO UPDATE SET
         staged=CASE WHEN staged IS NOT NULL THEN excluded.staged END",
        params![a.id, id, bytes.as_ref(), now()],
    )?;
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}
async fn download(
    State(s): State<AppState>,
    SignedIn(a): SignedIn,
    h: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Vec<u8>> {
    scope(&a, &h)?;
    s.db.with(|db| {
        db.query_row(
            "SELECT bytes FROM chunks WHERE account=? AND id=?",
            params![a.id, id],
            |r| r.get(0),
        )
        .optional()
    })?
    .ok_or(ApiError::Missing)
}
async fn missing(
    State(s): State<AppState>,
    SignedIn(a): SignedIn,
    h: HeaderMap,
    Json(ids): Json<Vec<String>>,
) -> ApiResult<Json<Vec<String>>> {
    scope(&a, &h)?;
    let db = s.db.0.lock().unwrap();
    let mut q = db.prepare("SELECT EXISTS(SELECT 1 FROM chunks WHERE account=? AND id=?)")?;
    let mut absent = Vec::new();
    for id in ids {
        if !q.query_row(params![a.id, id], |r| r.get::<_, bool>(0))? {
            absent.push(id)
        }
    }
    Ok(Json(absent))
}
#[derive(Deserialize)]
struct Confirmation {
    revision: u64,
}
async fn confirm(
    State(s): State<AppState>,
    SignedIn(a): SignedIn,
    h: HeaderMap,
    Json(c): Json<Confirmation>,
) -> ApiResult<StatusCode> {
    scope(&a, &h)?;
    let db = s.db.0.lock().unwrap();
    if current(&db, &a.id)? != c.revision {
        return Err(ApiError::Conflict("Revision changed".into()));
    }
    db.execute(
        "UPDATE sessions SET confirmed=? WHERE token_hash=?",
        params![c.revision, token_hash(session_token(&h).unwrap())],
    )?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Serialize)]
struct Device {
    device: String,
    confirmed: Option<u64>,
}
async fn devices(
    State(s): State<AppState>,
    SignedIn(a): SignedIn,
    h: HeaderMap,
) -> ApiResult<Json<Vec<Device>>> {
    scope(&a, &h)?;
    let sessions = s.db.with(|db| {
        let mut query = db.prepare(
            "SELECT device,confirmed FROM sessions WHERE account=? AND expires>? ORDER BY rowid",
        )?;
        query
            .query_map(params![a.id, now()], |row| {
                Ok(Device {
                    device: row.get(0)?,
                    confirmed: row.get(1)?,
                })
            })?
            .collect()
    })?;
    Ok(Json(sessions))
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/base", get(read).put(write))
        .route(
            "/chunks/{id}",
            get(download).put(upload),
        )
        .route("/missing", post(missing))
        .route("/confirm", post(confirm))
        .route("/devices", get(devices))
        .layer(DefaultBodyLimit::disable())
}
