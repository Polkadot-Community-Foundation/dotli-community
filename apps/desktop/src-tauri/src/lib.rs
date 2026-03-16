mod commands;
mod smoldot;

use commands::Wallet;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// The smoldot chain key used for DOTNS resolution (Asset Hub Paseo).
pub const DOTNS_CHAIN_KEY: &str = "dotns-asset-hub-paseo";

/// Shared asset store: app_id -> (path -> bytes)
///
/// Populated by `resolve_name`; read by the `dotapp://` protocol handler.
pub type AssetStore = Arc<Mutex<HashMap<String, HashMap<String, Vec<u8>>>>>;

/// Shared CID store: app_id -> CID string.
///
/// Populated by `resolve_name`; used by the protocol handler for on-demand IPFS fetches.
pub type CidStore = Arc<Mutex<HashMap<String, String>>>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Lock the wallet on system sleep (macOS Touch ID integration).
    host_wallet::register_sleep_observer();

    let asset_store: AssetStore = Arc::new(Mutex::new(HashMap::new()));
    let asset_store_for_protocol = asset_store.clone();

    let cid_store: CidStore = Arc::new(Mutex::new(HashMap::new()));
    let cid_store_for_protocol = cid_store.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Wallet(Mutex::new(host_wallet::WalletManager::new())))
        .manage(asset_store.clone())
        .manage(cid_store.clone())
        // Register the dotapp:// protocol handler before .setup()
        .register_uri_scheme_protocol("dotapp", move |_ctx, request| {
            let uri = request.uri();

            // uri.host() gives us "label.dot", uri.path() gives "/path/to/file"
            let host = uri.host().unwrap_or_default();
            let raw_path = uri.path();
            let path = raw_path.strip_prefix('/').unwrap_or(raw_path);
            let path = if path.is_empty() { "index.html" } else { path };

            // Percent-decode the path (e.g. "my%20file.js" -> "my file.js")
            let decoded = percent_decode_path(path);
            let path = decoded.as_str();

            // Block directory traversal (e.g. "../../etc/passwd")
            if path.split('/').any(|seg| seg == "..") {
                return tauri::http::Response::builder()
                    .status(400)
                    .body(b"Bad Request".to_vec())
                    .unwrap();
            }

            // Strip .dot suffix to recover the app_id (e.g. "myapp.dot" -> "myapp")
            let app_id = host.strip_suffix(".dot").unwrap_or(host);

            let store = asset_store_for_protocol
                .lock()
                .unwrap_or_else(|e| e.into_inner());

            if let Some(app_assets) = store.get(app_id) {
                // Try exact path match first, then fallback paths (mirrors SW logic)
                let resolved = resolve_asset_path(app_assets, path);
                if let Some((resolved_path, data)) = resolved {
                    let mime = mime_from_ext(resolved_path);
                    log::info!("[dotapp] {app_id}: {path} → 200 ({mime}, {} bytes)", data.len());
                    return tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(data.clone())
                        .unwrap();
                }
                log::warn!(
                    "[dotapp] {app_id}: {path} → cache miss (store has {} files)",
                    app_assets.len(),
                );
            }
            // Release the lock before making network requests
            drop(store);

            // On-demand IPFS fetch: if the file wasn't in the pre-fetched set,
            // re-fetch the full archive from IPFS and cache everything.
            let cid_opt = cid_store_for_protocol
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(app_id)
                .cloned();

            if let Some(cid) = cid_opt {
                log::info!("[dotapp] {app_id}: on-demand re-fetch from IPFS (CID: {cid})");

                // Re-fetch the full content tree from IPFS.
                match host_chain::dotns::fetch_ipfs(&cid) {
                    Ok(new_assets) if !new_assets.is_empty() => {
                        log::info!(
                            "[dotapp] {app_id}: re-fetched {} file(s) from IPFS",
                            new_assets.len()
                        );

                        // Normalize paths (strip common directory prefix)
                        let new_assets = commands::normalize_asset_paths(new_assets);

                        // Check if the requested path is now available
                        let found = resolve_asset_path(&new_assets, path)
                            .map(|(p, d)| (p.to_string(), d.clone()));

                        // Merge into the asset store for future requests
                        let mut guard = asset_store_for_protocol
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        let app_assets = guard.entry(app_id.to_string()).or_default();
                        for (k, v) in new_assets {
                            app_assets.insert(k, v);
                        }
                        drop(guard);

                        if let Some((resolved_path, data)) = found {
                            let mime = mime_from_ext(&resolved_path);
                            log::info!(
                                "[dotapp] {app_id}: {path} → 200 (on-demand, {mime}, {} bytes)",
                                data.len()
                            );
                            return tauri::http::Response::builder()
                                .status(200)
                                .header("Content-Type", mime)
                                .header("Access-Control-Allow-Origin", "*")
                                .body(data)
                                .unwrap();
                        }
                    }
                    Ok(_) => {
                        log::warn!("[dotapp] {app_id}: IPFS re-fetch returned empty");
                    }
                    Err(e) => {
                        log::warn!("[dotapp] {app_id}: IPFS re-fetch error: {e}");
                    }
                }
            } else {
                log::warn!("[dotapp] {app_id}: {path} → 404 (no CID available for on-demand fetch)");
            }

            // Content-Type prevents WebKit from interpreting the 404 as a download
            tauri::http::Response::builder()
                .status(404)
                .header("Content-Type", "text/plain")
                .body(b"Not Found".to_vec())
                .unwrap()
        })
        .setup(|app| {
            // Start the smoldot light client bridge, persisting chain DB snapshots
            // under <app-data-dir>/chain-db/ so restarts resume from the last
            // finalized block rather than syncing from genesis.
            let db_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("cannot determine app data dir: {e}"))?
                .join("chain-db");
            let (bridge, resp_rx) = smoldot::SmoldotBridge::new(db_dir);

            // Auto-connect Asset Hub Paseo for DOTNS resolution
            let paseo_ah_genesis =
                "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2";
            if let Some(chain_type) = smoldot::chain_type_for_genesis(paseo_ah_genesis) {
                bridge.send_cmd(smoldot::SmoldotCmd::AddChain {
                    chain_key: DOTNS_CHAIN_KEY.to_string(),
                    chain_type,
                });
                log::info!("[dotli] auto-connecting Asset Hub Paseo for DOTNS");
            }

            app.manage(bridge);

            // Drain smoldot responses → Tauri events
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                use tauri::Emitter;
                while let Ok(resp) = resp_rx.recv() {
                    let _ = handle.emit("smoldot-response", resp);
                }
            });

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::resolve_name,
            commands::fetch_ipfs,
            commands::wallet_create,
            commands::wallet_unlock,
            commands::wallet_lock,
            commands::wallet_sign,
            commands::wallet_public_key,
            commands::smoldot_connect,
            commands::rpc_send,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Resolve an asset path with fallback logic matching the web Service Worker.
///
/// Tries in order:
/// 1. Exact path match
/// 2. `path/index.html` (directory index)
/// 3. `"index.html"` for root/empty paths
/// 4. SPA fallback — serve `index.html` for extensionless paths
fn resolve_asset_path<'a>(
    assets: &'a HashMap<String, Vec<u8>>,
    path: &'a str,
) -> Option<(&'a str, &'a Vec<u8>)> {
    // 1. Exact match
    if let Some(data) = assets.get(path) {
        return Some((path, data));
    }

    let has_ext = path.rsplit('/').next().is_some_and(|seg| seg.contains('.'));

    // 2. Directory index: path + "/index.html"
    if !has_ext && !path.is_empty() {
        let with_index = format!("{path}/index.html");
        if let Some((k, v)) = assets.get_key_value(&with_index) {
            return Some((k.as_str(), v));
        }
    }

    // 3. Root path → "index.html"
    if path.is_empty() || path == "index.html" {
        if let Some((k, v)) = assets.get_key_value("index.html") {
            return Some((k.as_str(), v));
        }
    }

    // 4. SPA fallback — serve index.html for extensionless paths
    if !has_ext {
        if let Some((k, v)) = assets.get_key_value("index.html") {
            return Some((k.as_str(), v));
        }
    }

    None
}

/// Percent-decode a URL path segment (e.g. "my%20file.js" -> "my file.js").
/// Uses a simple inline decoder to avoid an extra crate dependency.
fn percent_decode_path(input: &str) -> String {
    let mut out = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

/// Map a file extension to a MIME type string.
fn mime_from_ext(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "application/javascript",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // -----------------------------------------------------------------------
    // mime_from_ext
    // -----------------------------------------------------------------------

    #[test]
    fn mime_html() {
        assert_eq!(mime_from_ext("index.html"), "text/html");
    }

    #[test]
    fn mime_css() {
        assert_eq!(mime_from_ext("styles.css"), "text/css");
    }

    #[test]
    fn mime_js() {
        assert_eq!(mime_from_ext("app.js"), "application/javascript");
    }

    #[test]
    fn mime_mjs() {
        assert_eq!(mime_from_ext("module.mjs"), "application/javascript");
    }

    #[test]
    fn mime_json() {
        assert_eq!(mime_from_ext("data.json"), "application/json");
    }

    #[test]
    fn mime_svg() {
        assert_eq!(mime_from_ext("icon.svg"), "image/svg+xml");
    }

    #[test]
    fn mime_png() {
        assert_eq!(mime_from_ext("img.png"), "image/png");
    }

    #[test]
    fn mime_jpg() {
        assert_eq!(mime_from_ext("photo.jpg"), "image/jpeg");
    }

    #[test]
    fn mime_jpeg() {
        assert_eq!(mime_from_ext("photo.jpeg"), "image/jpeg");
    }

    #[test]
    fn mime_gif() {
        assert_eq!(mime_from_ext("anim.gif"), "image/gif");
    }

    #[test]
    fn mime_webp() {
        assert_eq!(mime_from_ext("img.webp"), "image/webp");
    }

    #[test]
    fn mime_ico() {
        assert_eq!(mime_from_ext("favicon.ico"), "image/x-icon");
    }

    #[test]
    fn mime_woff() {
        assert_eq!(mime_from_ext("font.woff"), "font/woff");
    }

    #[test]
    fn mime_woff2() {
        assert_eq!(mime_from_ext("font.woff2"), "font/woff2");
    }

    #[test]
    fn mime_ttf() {
        assert_eq!(mime_from_ext("font.ttf"), "font/ttf");
    }

    #[test]
    fn mime_wasm() {
        assert_eq!(mime_from_ext("module.wasm"), "application/wasm");
    }

    #[test]
    fn mime_unknown_extension_is_octet_stream() {
        assert_eq!(mime_from_ext("archive.tar.gz"), "application/octet-stream");
    }

    #[test]
    fn mime_no_extension_is_octet_stream() {
        assert_eq!(mime_from_ext("Makefile"), "application/octet-stream");
    }

    #[test]
    fn mime_empty_path_is_octet_stream() {
        assert_eq!(mime_from_ext(""), "application/octet-stream");
    }

    // -----------------------------------------------------------------------
    // percent_decode_path
    // -----------------------------------------------------------------------

    #[test]
    fn percent_decode_plain_passthrough() {
        assert_eq!(percent_decode_path("index.html"), "index.html");
    }

    #[test]
    fn percent_decode_space() {
        assert_eq!(percent_decode_path("my%20file.js"), "my file.js");
    }

    #[test]
    fn percent_decode_slash_encoded() {
        // %2F is a literal slash
        assert_eq!(percent_decode_path("a%2Fb"), "a/b");
    }

    #[test]
    fn percent_decode_multibyte_utf8() {
        // é is U+00E9 → UTF-8 bytes 0xC3 0xA9 → %C3%A9
        assert_eq!(percent_decode_path("%C3%A9"), "é");
    }

    #[test]
    fn percent_decode_invalid_hex_is_kept_literal() {
        // %ZZ is not valid hex — the decoder should pass the '%' through literally
        let result = percent_decode_path("%ZZ");
        assert_eq!(result, "%ZZ");
    }

    #[test]
    fn percent_decode_truncated_sequence_is_kept_literal() {
        // A lone '%' at the end with only one following byte (not two) is kept as-is
        let result = percent_decode_path("%2");
        // bytes[0]=='%', i+2 == 2 which is NOT < bytes.len() (len==2), so '%' is kept
        assert_eq!(result, "%2");
    }

    #[test]
    fn percent_decode_empty_string() {
        assert_eq!(percent_decode_path(""), "");
    }

    #[test]
    fn percent_decode_mixed() {
        assert_eq!(
            percent_decode_path("hello%20world%2Findex.html"),
            "hello world/index.html"
        );
    }

    // -----------------------------------------------------------------------
    // resolve_asset_path
    // -----------------------------------------------------------------------

    fn make_assets(pairs: &[(&str, &str)]) -> HashMap<String, Vec<u8>> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.as_bytes().to_vec()))
            .collect()
    }

    #[test]
    fn resolve_exact_match() {
        let assets = make_assets(&[("index.html", "<html/>"), ("app.js", "console.log()")]);
        let (path, data) = resolve_asset_path(&assets, "app.js").unwrap();
        assert_eq!(path, "app.js");
        assert_eq!(data, b"console.log()");
    }

    #[test]
    fn resolve_empty_path_returns_index_html() {
        let assets = make_assets(&[("index.html", "<html/>")]);
        let (path, _) = resolve_asset_path(&assets, "").unwrap();
        assert_eq!(path, "index.html");
    }

    #[test]
    fn resolve_explicit_index_html_path() {
        let assets = make_assets(&[("index.html", "<html/>")]);
        let (path, _) = resolve_asset_path(&assets, "index.html").unwrap();
        assert_eq!(path, "index.html");
    }

    #[test]
    fn resolve_directory_index_fallback() {
        // Request "about" → should serve "about/index.html"
        let assets = make_assets(&[("about/index.html", "<html/>")]);
        let (path, _) = resolve_asset_path(&assets, "about").unwrap();
        assert_eq!(path, "about/index.html");
    }

    #[test]
    fn resolve_spa_fallback_extensionless_path() {
        // Request "settings/profile" (no extension) → serve "index.html" as SPA fallback
        let assets = make_assets(&[("index.html", "<html/>"), ("app.js", "")]);
        let (path, _) = resolve_asset_path(&assets, "settings/profile").unwrap();
        assert_eq!(path, "index.html");
    }

    #[test]
    fn resolve_extensioned_file_not_found_returns_none() {
        // "logo.png" is not in the store — should return None (no SPA fallback for extensions)
        let assets = make_assets(&[("index.html", "<html/>")]);
        let result = resolve_asset_path(&assets, "logo.png");
        assert!(result.is_none());
    }

    #[test]
    fn resolve_empty_assets_returns_none() {
        let assets: HashMap<String, Vec<u8>> = HashMap::new();
        assert!(resolve_asset_path(&assets, "index.html").is_none());
    }

    #[test]
    fn resolve_path_with_extension_uses_exact_match_only() {
        // Files with extensions are not subject to the SPA fallback.
        let assets = make_assets(&[("index.html", "<html/>"), ("other.css", "body{}")]);
        // "missing.css" has an extension and is not in the store.
        let result = resolve_asset_path(&assets, "missing.css");
        assert!(result.is_none());
    }

    #[test]
    fn resolve_nested_file_exact() {
        let assets =
            make_assets(&[("assets/logo.png", "PNGDATA"), ("index.html", "<html/>")]);
        let (path, _) = resolve_asset_path(&assets, "assets/logo.png").unwrap();
        assert_eq!(path, "assets/logo.png");
    }
}
