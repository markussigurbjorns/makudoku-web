use axum::{Json, Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};
use chrono::Utc;
use makudoku::{
    GenerationConfig, RenderOptions, VariantSpec, generate_random_variant_puzzle, render_puzzle_svg,
};
use serde::Serialize;
use sqlx::{Sqlite, SqlitePool, migrate::MigrateDatabase, sqlite::SqlitePoolOptions};
use std::{collections::HashSet, fs::create_dir_all, net::SocketAddr};
use tower_http::services::ServeDir;

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
}

#[derive(Serialize)]
struct PuzzleResponse {
    svg: Option<String>,
    variants: Vec<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    create_dir_all("data")?;

    let db_url = "sqlite:data/makudoku.db";

    if !Sqlite::database_exists(db_url).await? {
        Sqlite::create_database(db_url).await?;
    }

    let pool = SqlitePoolOptions::new()
        .max_connections(10) // look into this!!!!
        .connect(db_url)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    let state = AppState { db: pool };

    let public_dir = ServeDir::new("public").append_index_html_on_directories(true);
    let admin_dir = ServeDir::new("admin").append_index_html_on_directories(true);

    let app = Router::new()
        .route("/api/puzzle/today", get(today_puzzle_handler))
        .route("/api/puzzle/random", get(random_puzzle_handler))
        .with_state(state)
        .nest_service("/admin", admin_dir)
        .fallback_service(public_dir);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("listening on http://{}", listener.local_addr()?);

    axum::serve(listener, app).await?;
    Ok(())
}

pub fn variant_kinds(input: &[VariantSpec]) -> Vec<String> {
    let mut seen = HashSet::new();

    input
        .iter()
        .filter_map(|v| {
            let k = v.kind_str();
            seen.insert(k).then_some(k.to_string())
        })
        .collect()
}

async fn today_puzzle_handler(State(state): State<AppState>) -> impl IntoResponse {
    // Compute today's UTC date
    let today = Utc::now().date_naive().to_string();

    let row = sqlx::query!(
        r#"
        SELECT svg, variants
        FROM puzzles
        WHERE date_utc = ? AND status = 'published'
        "#,
        today
    )
    .fetch_optional(&state.db)
    .await;

    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => {
            return (StatusCode::NOT_FOUND, "Today's puzzle is not published yet").into_response();
        }
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {e}")).into_response();
        }
    };

    // variants is stored as JSON array string
    let variants: Vec<String> =
        serde_json::from_str(row.variants.as_deref().unwrap_or("[]")).unwrap_or_default();

    Json(PuzzleResponse {
        svg: row.svg,
        variants,
    })
    .into_response()
}

async fn random_puzzle_handler() -> impl IntoResponse {
    let cfg = GenerationConfig::default();
    let render_options = RenderOptions::default();

    let puzzle = match generate_random_variant_puzzle(cfg) {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to generate puzzle: {e}"),
            )
                .into_response();
        }
    };

    let puzzle_svg =
        match render_puzzle_svg(&puzzle.puzzle, &puzzle.engine.constraints, render_options) {
            Ok(svg) => svg,
            Err(err) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to render puzzle: {err}"),
                )
                    .into_response();
            }
        };

    let variants = variant_kinds(&puzzle.constraints);
    Json(PuzzleResponse {
        svg: Some(puzzle_svg),
        variants: variants,
    })
    .into_response()
}
