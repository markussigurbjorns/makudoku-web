use std::{collections::HashSet, net::SocketAddr};

use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::get};
use makudoku::{
    GenerationConfig, RenderOptions, VariantSpec, generate_random_variant_puzzle, render_puzzle_svg,
};
use serde::Serialize;
use tower_http::services::ServeDir;

#[derive(Serialize)]
struct PuzzleResponse<'a> {
    svg: String,
    solution: Vec<u8>,
    variants: Vec<&'a str>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let serve_dir = ServeDir::new("public").append_index_html_on_directories(true);

    let app = Router::new()
        .route("/api/puzzle/today", get(today_puzzle_handler))
        .fallback_service(serve_dir);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("listening on http://{}", listener.local_addr()?);

    axum::serve(listener, app).await?;
    Ok(())
}

pub fn variant_kinds(input: &[VariantSpec]) -> Vec<&'static str> {
    let mut seen = HashSet::new();

    input
        .iter()
        .filter_map(|v| {
            let k = v.kind_str();
            seen.insert(k).then_some(k)
        })
        .collect()
}

async fn today_puzzle_handler() -> impl IntoResponse {
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
        svg: puzzle_svg,
        solution: puzzle.solution.to_vec(),
        variants: variants,
    })
    .into_response()
}
