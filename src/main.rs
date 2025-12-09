use std::net::SocketAddr;

use axum::{Json, Router, http::StatusCode, response::IntoResponse, routing::get};
use makudoku::{
    GenerationConfig, RenderOptions, generate_random_variant_puzzle, render_puzzle_svg,
};
use serde::Serialize;
use tower_http::services::ServeDir;

#[derive(Serialize)]
struct PuzzleResponse {
    svg: String,
    solution: Vec<u8>,
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

    Json(PuzzleResponse {
        svg: puzzle_svg,
        solution: puzzle.solution.to_vec(),
    })
    .into_response()
}
