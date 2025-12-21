use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{SecondsFormat, Utc};
use makudoku::{
    Constraint, Engine, EngineRng, GenerationConfig, RenderOptions, SimpleRng, VariantSpec, NN,
    add_all_sudoku_constraints, add_arrow, add_killer_cage, add_king_constraints,
    add_knight_constraints, add_kropki_black, add_kropki_white, add_queen_constraints, add_thermo,
    generate_full_solution_with, generate_random_variant_puzzle, render_puzzle_svg,
};
use serde::{Deserialize, Serialize};
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
    title: Option<String>,
    date_utc: Option<String>,
}

#[derive(Deserialize)]
struct CheckRequest {
    grid: String,
}

#[derive(Serialize)]
struct CheckResponse {
    status: String,
}

#[derive(Deserialize)]
struct TrackRequest {
    event: String,
}

#[derive(Serialize)]
struct StatsResponse {
    date_utc: String,
    views: i64,
    checks: i64,
    solves: i64,
}

#[derive(Serialize)]
struct AdminGenerateResponse {
    puzzle_json: String,
    svg: String,
    variants: Vec<String>,
}

#[derive(Deserialize)]
struct AdminGenerateCustomRequest {
    constraints: serde_json::Value,
    clue_target: Option<usize>,
    seed: Option<u64>,
}

#[derive(Deserialize)]
struct AdminCreateRequest {
    date_utc: String,
    puzzle_json: String,
    svg: Option<String>,
    variants: Option<Vec<String>>,
    status: Option<String>,
    name: Option<String>,
    author: Option<String>,
    difficulty: Option<i64>,
    overwrite: Option<bool>,
}

#[derive(Deserialize)]
struct AdminListQuery {
    status: Option<String>,
}

#[derive(Serialize)]
struct AdminPuzzleSummary {
    date_utc: String,
    status: String,
    name: Option<String>,
    author: Option<String>,
    variants: Vec<String>,
    difficulty: Option<i64>,
    created_at_utc: String,
    published_at_utc: Option<String>,
}

#[derive(Serialize)]
struct AdminPuzzleResponse {
    date_utc: String,
    status: String,
    name: Option<String>,
    author: Option<String>,
    puzzle_json: String,
    svg: Option<String>,
    variants: Vec<String>,
    difficulty: Option<i64>,
    created_at_utc: String,
    updated_at_utc: String,
    published_at_utc: Option<String>,
}

#[derive(Debug)]
struct ParsedPuzzleJson {
    puzzle: String,
    constraints: Vec<serde_json::Value>,
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
        .route("/api/puzzle/check", post(check_puzzle_handler))
        .route("/api/puzzle/track", post(track_event_handler))
        .route("/api/admin/puzzles/generate", post(admin_generate_handler))
        .route(
            "/api/admin/puzzles/generate/custom",
            post(admin_generate_custom_handler),
        )
        .route("/api/admin/puzzles", post(admin_create_handler))
        .route("/api/admin/puzzles", get(admin_list_handler))
        .route("/api/admin/puzzles/{date_utc}", get(admin_get_handler))
        .route("/api/admin/stats/{date_utc}", get(admin_stats_handler))
        .route(
            "/api/admin/puzzles/{date_utc}/publish",
            post(admin_publish_handler),
        )
        .route(
            "/api/admin/puzzles/{date_utc}/archive",
            post(admin_archive_handler),
        )
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
        SELECT svg, variants, title
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
        title: row.title,
        date_utc: Some(today),
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
        title: None,
        date_utc: None,
    })
    .into_response()
}

fn parse_solution_from_json(value: &serde_json::Value) -> Result<Vec<u8>, String> {
    let sol = value
        .get("solution")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "solution missing".to_string())?;
    if sol.len() != NN {
        return Err("solution must have 81 digits".to_string());
    }
    let mut out = Vec::with_capacity(NN);
    for item in sol {
        let n = item
            .as_u64()
            .ok_or_else(|| "solution digits must be numbers".to_string())?;
        if n < 1 || n > 9 {
            return Err("solution digits must be 1-9".to_string());
        }
        out.push(n as u8);
    }
    Ok(out)
}

async fn check_puzzle_handler(
    State(state): State<AppState>,
    Json(req): Json<CheckRequest>,
) -> impl IntoResponse {
    let grid = req.grid.trim().to_string();
    if grid.chars().count() != NN {
        return (
            StatusCode::BAD_REQUEST,
            "grid must be exactly 81 characters",
        )
            .into_response();
    }

    let today = Utc::now().date_naive().to_string();
    let row = sqlx::query!(
        r#"
        SELECT puzzle_json
        FROM puzzles
        WHERE date_utc = ? AND status = 'published'
        "#,
        today
    )
    .fetch_optional(&state.db)
    .await;

    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "Puzzle not published").into_response(),
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {e}"))
                .into_response();
        }
    };

    let puzzle_json: serde_json::Value = match serde_json::from_str(&row.puzzle_json) {
        Ok(val) => val,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Invalid puzzle data",
            )
                .into_response();
        }
    };

    let solution = match parse_solution_from_json(&puzzle_json) {
        Ok(solution) => solution,
        Err(_) => {
            return Json(CheckResponse {
                status: "unavailable".to_string(),
            })
            .into_response();
        }
    };

    let now_value = now_utc_string();
    let _ = sqlx::query!(
        r#"
        INSERT INTO puzzle_stats (date_utc, checks, last_seen_utc)
        VALUES (?, 1, ?)
        ON CONFLICT(date_utc) DO UPDATE SET
            checks = checks + 1,
            last_seen_utc = excluded.last_seen_utc
        "#,
        today,
        now_value,
    )
    .execute(&state.db)
    .await;

    let mut incomplete = false;
    for (idx, ch) in grid.chars().enumerate() {
        if ch == '.' || ch == '0' {
            incomplete = true;
            continue;
        }
        let digit = ch.to_digit(10);
        let digit = match digit {
            Some(d) if (1..=9).contains(&d) => d as u8,
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "grid must contain digits 1-9 or '.'",
                )
                    .into_response();
            }
        };
        if digit != solution[idx] {
            return Json(CheckResponse {
                status: "incorrect".to_string(),
            })
            .into_response();
        }
    }

    let status = if incomplete { "partial" } else { "complete" };
    if status == "complete" {
        let now_value = now_utc_string();
        let _ = sqlx::query!(
            r#"
            INSERT INTO puzzle_stats (date_utc, solves, last_seen_utc)
            VALUES (?, 1, ?)
            ON CONFLICT(date_utc) DO UPDATE SET
                solves = solves + 1,
                last_seen_utc = excluded.last_seen_utc
            "#,
            today,
            now_value,
        )
        .execute(&state.db)
        .await;
    }
    Json(CheckResponse {
        status: status.to_string(),
    })
    .into_response()
}

async fn track_event_handler(
    State(state): State<AppState>,
    Json(req): Json<TrackRequest>,
) -> impl IntoResponse {
    let today = Utc::now().date_naive().to_string();
    let now = now_utc_string();
    let event = req.event.as_str();

    let result = match event {
        "view" => {
            sqlx::query!(
                r#"
                INSERT INTO puzzle_stats (date_utc, views, last_seen_utc)
                VALUES (?, 1, ?)
                ON CONFLICT(date_utc) DO UPDATE SET
                    views = views + 1,
                    last_seen_utc = excluded.last_seen_utc
                "#,
                today,
                now,
            )
            .execute(&state.db)
            .await
        }
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                "event must be one of: view",
            )
                .into_response();
        }
    };

    if let Err(e) = result {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("DB error: {e}"),
        )
            .into_response();
    }

    StatusCode::NO_CONTENT.into_response()
}

async fn admin_stats_handler(
    State(state): State<AppState>,
    Path(date_utc): Path<String>,
) -> impl IntoResponse {
    let row = sqlx::query!(
        r#"
        SELECT date_utc, views, checks, solves
        FROM puzzle_stats
        WHERE date_utc = ?
        "#,
        date_utc
    )
    .fetch_optional(&state.db)
    .await;

    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => {
            return Json(StatsResponse {
                date_utc,
                views: 0,
                checks: 0,
                solves: 0,
            })
            .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {e}"),
            )
                .into_response();
        }
    };

    Json(StatsResponse {
        date_utc: row.date_utc.unwrap_or_default(),
        views: row.views,
        checks: row.checks,
        solves: row.solves,
    })
    .into_response()
}

fn now_utc_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn dedupe_variants(input: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in input {
        if seen.insert(item.clone()) {
            out.push(item);
        }
    }
    out
}

fn parse_puzzle_json(puzzle_json: &str) -> Result<ParsedPuzzleJson, String> {
    let value: serde_json::Value =
        serde_json::from_str(puzzle_json).map_err(|e| format!("invalid JSON: {e}"))?;
    let puzzle = value
        .get("puzzle")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing puzzle string".to_string())?
        .to_string();

    let constraints = value
        .get("constraints")
        .and_then(|v| v.as_array())
        .map(|v| v.to_vec())
        .unwrap_or_default();

    Ok(ParsedPuzzleJson { puzzle, constraints })
}

fn variants_from_constraints(constraints: &[serde_json::Value]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for item in constraints {
        let kind = item
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "constraint missing type".to_string())?;
        out.push(kind.to_string());
    }
    Ok(dedupe_variants(out))
}

fn parse_cell(value: &serde_json::Value) -> Result<(usize, usize), String> {
    let arr = value
        .as_array()
        .ok_or_else(|| "cell must be a [row, col] array".to_string())?;
    if arr.len() != 2 {
        return Err("cell must have two elements".to_string());
    }
    let r = arr[0]
        .as_u64()
        .ok_or_else(|| "row must be an integer".to_string())? as usize;
    let c = arr[1]
        .as_u64()
        .ok_or_else(|| "col must be an integer".to_string())? as usize;
    Ok((r, c))
}

fn parse_path(value: &serde_json::Value) -> Result<Vec<(usize, usize)>, String> {
    let arr = value
        .as_array()
        .ok_or_else(|| "path must be an array of cells".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for cell in arr {
        out.push(parse_cell(cell)?);
    }
    if out.is_empty() {
        return Err("path must have at least one cell".to_string());
    }
    Ok(out)
}

fn constraints_from_json(
    constraints: &[serde_json::Value],
) -> Result<Vec<VariantSpec>, String> {
    let mut out = Vec::new();
    for item in constraints {
        let kind = item
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "constraint missing type".to_string())?;
        match kind {
            "kropki_white" => {
                let a = parse_cell(
                    item.get("a")
                        .ok_or_else(|| "kropki_white missing a".to_string())?,
                )?;
                let b = parse_cell(
                    item.get("b")
                        .ok_or_else(|| "kropki_white missing b".to_string())?,
                )?;
                out.push(VariantSpec::KropkiWhite(a, b));
            }
            "kropki_black" => {
                let a = parse_cell(
                    item.get("a")
                        .ok_or_else(|| "kropki_black missing a".to_string())?,
                )?;
                let b = parse_cell(
                    item.get("b")
                        .ok_or_else(|| "kropki_black missing b".to_string())?,
                )?;
                out.push(VariantSpec::KropkiBlack(a, b));
            }
            "thermo" => {
                let path = parse_path(
                    item.get("path")
                        .ok_or_else(|| "thermo missing path".to_string())?,
                )?;
                out.push(VariantSpec::Thermo(path));
            }
            "arrow" => {
                let path = parse_path(
                    item.get("path")
                        .ok_or_else(|| "arrow missing path".to_string())?,
                )?;
                out.push(VariantSpec::Arrow(path));
            }
            "killer" => {
                let cells = parse_path(
                    item.get("cells")
                        .ok_or_else(|| "killer missing cells".to_string())?,
                )?;
                let sum = item
                    .get("sum")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| "killer missing sum".to_string())?;
                let no_repeats = item
                    .get("no_repeats")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                out.push(VariantSpec::Killer {
                    cells,
                    sum: sum as u8,
                    no_repeats,
                });
            }
            "king" => out.push(VariantSpec::King),
            "knight" => out.push(VariantSpec::Knight),
            "queen" => out.push(VariantSpec::Queen),
            other => return Err(format!("unknown constraint type: {other}")),
        }
    }
    Ok(out)
}

fn normalize_constraints_input(
    input: serde_json::Value,
) -> Result<Vec<serde_json::Value>, String> {
    if let Some(arr) = input.as_array() {
        return Ok(arr.to_vec());
    }
    if let Some(arr) = input.get("constraints").and_then(|v| v.as_array()) {
        return Ok(arr.to_vec());
    }
    Err("constraints must be a JSON array".to_string())
}

fn apply_variant_specs(engine: &mut Engine, specs: &[VariantSpec]) {
    for spec in specs {
        match spec {
            VariantSpec::KropkiWhite(a, b) => add_kropki_white(engine, *a, *b),
            VariantSpec::KropkiBlack(a, b) => add_kropki_black(engine, *a, *b),
            VariantSpec::Thermo(path) => add_thermo(engine, path),
            VariantSpec::Arrow(path) => add_arrow(engine, path),
            VariantSpec::Killer {
                cells,
                sum,
                no_repeats,
            } => add_killer_cage(engine, cells, *sum, *no_repeats),
            VariantSpec::King => add_king_constraints(engine),
            VariantSpec::Knight => add_knight_constraints(engine),
            VariantSpec::Queen => add_queen_constraints(engine),
        }
    }
}

fn engine_constraints_from_specs(specs: &[VariantSpec]) -> Vec<Constraint> {
    let mut eng = Engine::new();
    add_all_sudoku_constraints(&mut eng);
    apply_variant_specs(&mut eng, specs);
    eng.constraints
}

fn variant_specs_to_json(specs: &[VariantSpec]) -> Vec<serde_json::Value> {
    specs
        .iter()
        .map(|spec| match spec {
            VariantSpec::KropkiWhite(a, b) => serde_json::json!({
                "type": "kropki_white",
                "a": [a.0, a.1],
                "b": [b.0, b.1],
            }),
            VariantSpec::KropkiBlack(a, b) => serde_json::json!({
                "type": "kropki_black",
                "a": [a.0, a.1],
                "b": [b.0, b.1],
            }),
            VariantSpec::Thermo(path) => serde_json::json!({
                "type": "thermo",
                "path": path.iter().map(|(r, c)| serde_json::json!([r, c])).collect::<Vec<_>>(),
            }),
            VariantSpec::Arrow(path) => serde_json::json!({
                "type": "arrow",
                "path": path.iter().map(|(r, c)| serde_json::json!([r, c])).collect::<Vec<_>>(),
            }),
            VariantSpec::Killer {
                cells,
                sum,
                no_repeats,
            } => serde_json::json!({
                "type": "killer",
                "cells": cells.iter().map(|(r, c)| serde_json::json!([r, c])).collect::<Vec<_>>(),
                "sum": sum,
                "no_repeats": no_repeats,
            }),
            VariantSpec::King => serde_json::json!({ "type": "king" }),
            VariantSpec::Knight => serde_json::json!({ "type": "knight" }),
            VariantSpec::Queen => serde_json::json!({ "type": "queen" }),
        })
        .collect()
}

async fn admin_generate_handler() -> impl IntoResponse {
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
    let constraints_json = variant_specs_to_json(&puzzle.constraints);

    let puzzle_json = serde_json::json!({
        "puzzle": puzzle.puzzle,
        "solution": puzzle.solution.to_vec(),
        "constraints": constraints_json,
        "seed": puzzle.seed,
        "clue_count": puzzle.clue_count,
        "symmetry": puzzle.symmetry.map(|s| format!("{s:?}")),
    });

    Json(AdminGenerateResponse {
        puzzle_json: puzzle_json.to_string(),
        svg: puzzle_svg,
        variants,
    })
    .into_response()
}

fn puzzle_vec_to_string(puzzle: &[Option<u8>]) -> String {
    let mut s = String::with_capacity(NN);
    for cell in puzzle.iter() {
        match cell {
            Some(d) => s.push((b'0' + *d) as char),
            None => s.push('.'),
        }
    }
    s
}

fn has_unique_solution_with_specs(
    puzzle: &str,
    specs: &[VariantSpec],
    rng: &mut SimpleRng,
) -> bool {
    let mut eng = Engine::new();
    add_all_sudoku_constraints(&mut eng);
    apply_variant_specs(&mut eng, specs);
    if eng.load_givens(puzzle).is_err() {
        return false;
    }
    eng.has_unique_solution_with_rng(rng)
}

fn shuffle_indices(rng: &mut SimpleRng, positions: &mut [usize]) {
    if positions.len() <= 1 {
        return;
    }
    for i in (1..positions.len()).rev() {
        let j = rng.gen_range(0..i + 1);
        positions.swap(i, j);
    }
}

fn generate_puzzle_from_solution(
    solution: &[u8; NN],
    target_clues: usize,
    specs: &[VariantSpec],
    rng: &mut SimpleRng,
) -> Result<String, String> {
    if target_clues >= NN {
        return Err("clue_target must be less than 81".to_string());
    }

    let mut puzzle: Vec<Option<u8>> = solution.iter().copied().map(Some).collect();
    let mut positions: Vec<usize> = (0..NN).collect();
    shuffle_indices(rng, &mut positions);

    for pos in positions {
        let saved = puzzle[pos];
        puzzle[pos] = None;
        let puzzle_str = puzzle_vec_to_string(&puzzle);
        if !has_unique_solution_with_specs(&puzzle_str, specs, rng) {
            puzzle[pos] = saved;
        }
        let clues_now = puzzle.iter().filter(|c| c.is_some()).count();
        if clues_now <= target_clues {
            break;
        }
    }

    Ok(puzzle_vec_to_string(&puzzle))
}

async fn admin_generate_custom_handler(
    Json(req): Json<AdminGenerateCustomRequest>,
) -> impl IntoResponse {
    let constraints = match normalize_constraints_input(req.constraints) {
        Ok(list) => list,
        Err(err) => return (StatusCode::BAD_REQUEST, err).into_response(),
    };

    let specs = match constraints_from_json(&constraints) {
        Ok(specs) => specs,
        Err(err) => return (StatusCode::BAD_REQUEST, err).into_response(),
    };

    let mut rng = match req.seed {
        Some(seed) => SimpleRng::from_seed(seed),
        None => SimpleRng::new(),
    };
    let seed = req.seed.unwrap_or_else(|| rng.seed());

    let solution = match generate_full_solution_with(rng.clone(), |eng| {
        apply_variant_specs(eng, &specs);
    }) {
        Ok(sol) => sol,
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err).into_response(),
    };

    let clue_target = req.clue_target.unwrap_or(30);
    let puzzle = match generate_puzzle_from_solution(&solution, clue_target, &specs, &mut rng) {
        Ok(puzzle) => puzzle,
        Err(err) => return (StatusCode::BAD_REQUEST, err).into_response(),
    };

    let constraints_json = constraints;
    let variants = variant_kinds(&specs);
    let clue_count = puzzle.chars().filter(|c| *c != '.').count();

    let puzzle_json = serde_json::json!({
        "puzzle": puzzle,
        "solution": solution.to_vec(),
        "constraints": constraints_json,
        "seed": seed,
        "clue_count": clue_count,
        "symmetry": null,
    });

    let render_options = RenderOptions::default();
    let constraints_render = engine_constraints_from_specs(&specs);
    let puzzle_svg = match render_puzzle_svg(&puzzle, &constraints_render, render_options) {
        Ok(svg) => svg,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to render puzzle: {err}"),
            )
                .into_response();
        }
    };

    Json(AdminGenerateResponse {
        puzzle_json: puzzle_json.to_string(),
        svg: puzzle_svg,
        variants,
    })
    .into_response()
}

async fn admin_create_handler(
    State(state): State<AppState>,
    Json(req): Json<AdminCreateRequest>,
) -> Response {
    let AdminCreateRequest {
        date_utc,
        puzzle_json,
        svg,
        variants,
        status,
        name,
        author,
        difficulty,
        overwrite,
    } = req;

    let overwrite = overwrite.unwrap_or(true);
    if !overwrite {
        let date_utc_value = date_utc.clone();
        let existing = sqlx::query!(
            r#"SELECT date_utc FROM puzzles WHERE date_utc = ?"#,
            date_utc_value
        )
        .fetch_optional(&state.db)
        .await;
        match existing {
            Ok(Some(_)) => {
                return (StatusCode::CONFLICT, "Puzzle already exists").into_response();
            }
            Ok(None) => {}
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("DB error: {e}"),
                )
                    .into_response();
            }
        }
    }

    let parsed = match parse_puzzle_json(&puzzle_json) {
        Ok(parsed) => parsed,
        Err(err) => return (StatusCode::BAD_REQUEST, err).into_response(),
    };

    let variants = match &variants {
        Some(list) => dedupe_variants(list.clone()),
        None => match variants_from_constraints(&parsed.constraints) {
            Ok(list) => list,
            Err(err) => return (StatusCode::BAD_REQUEST, err).into_response(),
        },
    };

    let svg = if let Some(svg) = svg {
        Some(svg)
    } else {
        let specs = match constraints_from_json(&parsed.constraints) {
            Ok(specs) => specs,
            Err(err) => return (StatusCode::BAD_REQUEST, err).into_response(),
        };
        let constraints = engine_constraints_from_specs(&specs);
        let render_options = RenderOptions::default();
        match render_puzzle_svg(&parsed.puzzle, &constraints, render_options) {
            Ok(svg) => Some(svg),
            Err(err) => return (StatusCode::BAD_REQUEST, err).into_response(),
        }
    };

    let status = status.unwrap_or_else(|| "draft".to_string());
    let published_at = if status == "published" {
        Some(now_utc_string())
    } else {
        None
    };

    let variants_json = match serde_json::to_string(&variants) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to encode variants: {e}"),
            )
                .into_response();
        }
    };

    let date_utc_value = date_utc.clone();
    let result = sqlx::query!(
        r#"
        INSERT INTO puzzles (
            date_utc, status, puzzle_json, svg, render_version,
            title, author, difficulty, variants, published_at_utc
        )
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT(date_utc) DO UPDATE SET
            status = excluded.status,
            puzzle_json = excluded.puzzle_json,
            svg = excluded.svg,
            render_version = excluded.render_version,
            title = excluded.title,
            author = excluded.author,
            difficulty = excluded.difficulty,
            variants = excluded.variants,
            published_at_utc = excluded.published_at_utc
        "#,
        date_utc_value,
        status,
        puzzle_json,
        svg,
        name,
        author,
        difficulty,
        variants_json,
        published_at,
    )
    .execute(&state.db)
    .await;

    if let Err(e) = result {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("DB error: {e}"),
        )
            .into_response();
    }

    admin_get_handler(State(state), Path(date_utc)).await
}

async fn admin_list_handler(
    State(state): State<AppState>,
    Query(query): Query<AdminListQuery>,
) -> impl IntoResponse {
    if let Some(status) = query.status {
        let rows = sqlx::query!(
            r#"
            SELECT date_utc, status, title, author, variants, difficulty,
                   created_at_utc, published_at_utc
            FROM puzzles
            WHERE status = ?
            ORDER BY date_utc DESC
            "#,
            status
        )
        .fetch_all(&state.db)
        .await;

        let rows = match rows {
            Ok(rows) => rows,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("DB error: {e}"),
                )
                    .into_response();
            }
        };

        let out: Vec<AdminPuzzleSummary> = rows
            .into_iter()
            .map(|row| AdminPuzzleSummary {
                date_utc: row.date_utc.unwrap_or_default(),
                status: row.status,
                name: row.title,
                author: row.author,
                variants: serde_json::from_str(row.variants.as_deref().unwrap_or("[]"))
                    .unwrap_or_default(),
                difficulty: row.difficulty,
                created_at_utc: row.created_at_utc,
                published_at_utc: row.published_at_utc,
            })
            .collect();

        return Json(out).into_response();
    }

    let rows = sqlx::query!(
            r#"
            SELECT date_utc, status, title, author, variants, difficulty,
                   created_at_utc, published_at_utc
            FROM puzzles
            ORDER BY date_utc DESC
            "#
        )
        .fetch_all(&state.db)
        .await;

    let rows = match rows {
        Ok(rows) => rows,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {e}"),
            )
                .into_response();
        }
    };

    let out: Vec<AdminPuzzleSummary> = rows
        .into_iter()
        .map(|row| AdminPuzzleSummary {
            date_utc: row.date_utc.unwrap_or_default(),
            status: row.status,
            name: row.title,
            author: row.author,
            variants: serde_json::from_str(row.variants.as_deref().unwrap_or("[]"))
                .unwrap_or_default(),
            difficulty: row.difficulty,
            created_at_utc: row.created_at_utc,
            published_at_utc: row.published_at_utc,
        })
        .collect();

    Json(out).into_response()
}

async fn admin_get_handler(
    State(state): State<AppState>,
    Path(date_utc): Path<String>,
) -> Response {
    let row = sqlx::query!(
        r#"
        SELECT date_utc, status, title, author, puzzle_json, svg, variants,
               difficulty, created_at_utc, updated_at_utc, published_at_utc
        FROM puzzles
        WHERE date_utc = ?
        "#,
        date_utc
    )
    .fetch_optional(&state.db)
    .await;

    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "Puzzle not found").into_response(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB error: {e}"),
            )
                .into_response();
        }
    };

    let variants: Vec<String> =
        serde_json::from_str(row.variants.as_deref().unwrap_or("[]")).unwrap_or_default();

    Json(AdminPuzzleResponse {
        date_utc: row.date_utc.unwrap_or(date_utc),
        status: row.status,
        name: row.title,
        author: row.author,
        puzzle_json: row.puzzle_json,
        svg: row.svg,
        variants,
        difficulty: row.difficulty,
        created_at_utc: row.created_at_utc,
        updated_at_utc: row.updated_at_utc,
        published_at_utc: row.published_at_utc,
    })
    .into_response()
}

async fn admin_publish_handler(
    State(state): State<AppState>,
    Path(date_utc): Path<String>,
) -> Response {
    let published_at = now_utc_string();
    let result = sqlx::query!(
        r#"
        UPDATE puzzles
        SET status = 'published', published_at_utc = ?
        WHERE date_utc = ?
        "#,
        published_at,
        date_utc
    )
    .execute(&state.db)
    .await;

    match result {
        Ok(result) if result.rows_affected() == 0 => {
            (StatusCode::NOT_FOUND, "Puzzle not found").into_response()
        }
        Ok(_) => admin_get_handler(State(state), Path(date_utc)).await,
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("DB error: {e}"),
        )
            .into_response(),
    }
}

async fn admin_archive_handler(
    State(state): State<AppState>,
    Path(date_utc): Path<String>,
) -> Response {
    let result = sqlx::query!(
        r#"
        UPDATE puzzles
        SET status = 'archived'
        WHERE date_utc = ?
        "#,
        date_utc
    )
    .execute(&state.db)
    .await;

    match result {
        Ok(result) if result.rows_affected() == 0 => {
            (StatusCode::NOT_FOUND, "Puzzle not found").into_response()
        }
        Ok(_) => admin_get_handler(State(state), Path(date_utc)).await,
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("DB error: {e}"),
        )
            .into_response(),
    }
}
