mod auth;
mod sync;
use axum::{
    Json, Router,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug)]
enum ApiError {
    Unauthorized,
    Forbidden,
    SignupClosed,
    BadRequest(String),
    Conflict(String),
    Internal(String),
    Missing,
}
type ApiResult<T> = Result<T, ApiError>;
impl From<rusqlite::Error> for ApiError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Internal("Database operation failed".into())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (code, msg) = match self {
            Self::Unauthorized => (401, "Sign in again".into()),
            Self::Forbidden => (403, "Account mismatch".into()),
            Self::SignupClosed => (403, "Signups are closed".into()),
            Self::BadRequest(s) => (400, s),
            Self::Conflict(s) => (409, s),
            Self::Internal(s) => (500, s),
            Self::Missing => (404, "Missing chunk".into()),
        };
        (
            StatusCode::from_u16(code).unwrap(),
            Json(serde_json::json!({"error":msg})),
        )
            .into_response()
    }
}
#[derive(Serialize)]
struct Account {
    id: String,
    name: String,
    generation: u32,
}
struct Db(Mutex<Connection>);
impl Db {
    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        f(&self.0.lock().unwrap())
    }
    fn session(&self, token: &str, time: i64) -> rusqlite::Result<Option<Account>> {
        self.with(|db| {
            db.query_row(
                "SELECT id,name,credential_generation FROM sessions JOIN accounts ON id=account
                 WHERE token_hash=?1 AND expires>?2",
                rusqlite::params![token, time],
                |row| {
                    Ok(Account {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        generation: row.get(2)?,
                    })
                },
            )
            .optional()
        })
    }
}
struct Service {
    db: Db,
    auth: auth::OpaqueAuth,
    signup: bool,
}
type AppState = Arc<Service>;
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
fn random_token(n: usize) -> String {
    let mut bytes = vec![0; n];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = PathBuf::from(std::env::var("OLYMP_DATA").unwrap_or_else(|_| "olymp-data".into()));
    let mut directory = std::fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(&dir)?;
    let conn = Connection::open(dir.join("olymp.db"))?;
    conn.execute_batch(include_str!("schema.sql"))?;
    let db = Db(Mutex::new(conn));
    let auth = auth::OpaqueAuth::open(&db, &dir)?;
    let state = Arc::new(Service {
        db,
        auth,
        signup: std::env::var("OLYMP_SIGNUP").as_deref() == Ok("open"),
    });
    let api = auth::routes()
        .merge(sync::routes())
        .layer(axum::middleware::map_response(
            |mut r: Response| async move {
                r.headers_mut()
                    .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                r
            },
        ));
    let app = Router::new()
        .nest("/v1", api)
        .route(
            "/",
            get(async || axum::response::Html(include_str!("../web/index.html"))),
        )
        .route("/{*asset}", get(asset))
        .with_state(state);
    // Socket-activated HTTP/1 on an inherited Unix stream (also used by tests).
    #[cfg(unix)]
    if std::env::args().nth(1).as_deref() == Some("--connected-stdin") {
        use std::os::fd::AsFd;
        let stream =
            std::os::unix::net::UnixStream::from(std::io::stdin().as_fd().try_clone_to_owned()?);
        stream.set_nonblocking(true)?;
        let io = hyper_util::rt::TokioIo::new(tokio::net::UnixStream::from_std(stream)?);
        println!("Olymp v1 ready");
        hyper::server::conn::http1::Builder::new()
            .serve_connection(io, hyper_util::service::TowerToHyperService::new(app))
            .await?;
        return Ok(());
    }
    let listener = tokio::net::TcpListener::bind(
        std::env::var("OLYMP_LISTEN").unwrap_or_else(|_| "127.0.0.1:8787".into()),
    )
    .await?;
    println!("Olymp v1 listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}
async fn asset(axum::extract::Path(name): axum::extract::Path<String>) -> Response {
    let (mime, bytes): (&str, &'static [u8]) = match name.as_str() {
        "ui.js" => ("text/javascript", include_bytes!("../web/ui.js")),
        "client.js" => ("text/javascript", include_bytes!("../web/client.js")),
        "browser.js" => ("text/javascript", include_bytes!("../web/browser.js")),
        "opaque/opaque.js" => ("text/javascript", include_bytes!("../web/opaque/opaque.js")),
        "sodium/libsodium-wrappers.mjs" => (
            "text/javascript",
            include_bytes!("../web/sodium/libsodium-wrappers.mjs"),
        ),
        "sodium/libsodium-sumo.mjs" => (
            "text/javascript",
            include_bytes!("../web/sodium/libsodium-sumo.mjs"),
        ),
        "opaque/opaque_bg.wasm" => (
            "application/wasm",
            include_bytes!("../web/opaque/opaque_bg.wasm"),
        ),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    ([(header::CONTENT_TYPE, mime)], bytes).into_response()
}
