use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

use crate::smoldot::{SmoldotBridge, SmoldotCmd};
use crate::{AssetStore, CidStore};
use std::sync::Arc;

/// Shared wallet state, managed by Tauri.
pub struct Wallet(pub Mutex<host_wallet::WalletManager>);

/// Metadata result returned over IPC — no asset bytes cross the boundary.
#[derive(Serialize)]
pub struct ResolveResult {
    pub cid: String,
    pub owner: Option<String>,
    /// The app identifier (the .dot label that was resolved).
    pub app_id: String,
    /// File paths available in the asset store (no content).
    pub files: Vec<String>,
}

// ── Tests ──────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn assets(pairs: &[(&str, &[u8])]) -> HashMap<String, Vec<u8>> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_vec()))
            .collect()
    }

    // -----------------------------------------------------------------------
    // normalize_asset_paths
    // -----------------------------------------------------------------------

    /// An empty map is returned unchanged.
    #[test]
    fn normalize_empty_map_unchanged() {
        let result = normalize_asset_paths(HashMap::new());
        assert!(result.is_empty());
    }

    /// If "index.html" is already a top-level key, no stripping occurs.
    #[test]
    fn normalize_already_normalized_unchanged() {
        let input = assets(&[("index.html", b"<html/>"), ("app.js", b"")]);
        let result = normalize_asset_paths(input.clone());
        assert_eq!(result, input);
    }

    /// A common directory prefix is stripped from all keys.
    #[test]
    fn normalize_strips_common_prefix() {
        let input = assets(&[
            ("myapp/index.html", b"<html/>"),
            ("myapp/app.js", b"console.log()"),
        ]);
        let result = normalize_asset_paths(input);
        assert!(result.contains_key("index.html"), "{result:?}");
        assert!(result.contains_key("app.js"), "{result:?}");
        assert!(!result.contains_key("myapp/index.html"));
    }

    /// Values are preserved exactly after prefix stripping.
    #[test]
    fn normalize_preserves_values() {
        let input = assets(&[("app/index.html", b"hello"), ("app/style.css", b"world")]);
        let result = normalize_asset_paths(input);
        assert_eq!(result.get("index.html").map(Vec::as_slice), Some(b"hello" as &[u8]));
        assert_eq!(result.get("style.css").map(Vec::as_slice), Some(b"world" as &[u8]));
    }

    /// Keys with mixed prefixes are left untouched.
    #[test]
    fn normalize_mixed_prefixes_unchanged() {
        let input = assets(&[
            ("alpha/index.html", b""),
            ("beta/app.js", b""),
        ]);
        let result = normalize_asset_paths(input.clone());
        assert_eq!(result, input);
    }

    /// A flat file with no directory separator is left untouched.
    #[test]
    fn normalize_flat_file_no_prefix_unchanged() {
        let input = assets(&[("README.txt", b"hello")]);
        let result = normalize_asset_paths(input.clone());
        assert_eq!(result, input);
    }

    /// Deeply nested files under a common prefix are stripped correctly.
    #[test]
    fn normalize_deeply_nested_common_prefix() {
        let input = assets(&[
            ("dist/assets/img.png", b"\x89PNG"),
            ("dist/index.html", b"<html/>"),
        ]);
        let result = normalize_asset_paths(input);
        // "dist/" prefix is stripped; result keys should be "assets/img.png" and "index.html"
        assert!(result.contains_key("assets/img.png"), "{result:?}");
        assert!(result.contains_key("index.html"), "{result:?}");
    }

    /// A single file with a directory prefix is normalized.
    #[test]
    fn normalize_single_file_with_prefix() {
        let input = assets(&[("build/main.js", b"code")]);
        let result = normalize_asset_paths(input);
        assert!(result.contains_key("main.js"), "{result:?}");
        assert!(!result.contains_key("build/main.js"));
    }
}

// ── Chain commands ──────────────────────────────────────────

#[tauri::command]
pub async fn resolve_name(
    name: String,
    asset_store: State<'_, AssetStore>,
    cid_store: State<'_, CidStore>,
    bridge: State<'_, SmoldotBridge>,
) -> Result<ResolveResult, String> {
    let store = asset_store.inner().clone();
    let cid_store = cid_store.inner().clone();
    let bridge_clone = bridge.inner().clone();

    tokio::task::spawn_blocking(move || {
        // True race: HTTP RPC and smoldot resolve concurrently via a channel.
        // First successful result wins; the second verifies in background.
        let (tx, rx) = std::sync::mpsc::channel::<(String, String)>();

        // Spawn smoldot resolver
        {
            let tx = tx.clone();
            let name = name.clone();
            let bridge = bridge_clone.clone();
            std::thread::spawn(move || {
                let transport: Arc<host_chain::dotns::RpcTransportFn> =
                    Arc::new(move |request: &str| {
                        bridge.rpc_call(crate::DOTNS_CHAIN_KEY, request)
                    });
                if let Ok(cid) = host_chain::dotns::resolve_dotns_with(&name, &*transport) {
                    let _ = tx.send(("smoldot".into(), cid));
                }
            });
        }

        // Spawn HTTP resolver
        {
            let name = name.clone();
            std::thread::spawn(move || {
                if let Ok(cid) = host_chain::dotns::resolve_dotns(&name) {
                    let _ = tx.send(("http".into(), cid));
                }
            });
        }

        // First success wins (60s covers smoldot cold start)
        let (first_source, cid) = rx
            .recv_timeout(std::time::Duration::from_secs(60))
            .map_err(|_| "all resolution methods failed or timed out".to_string())?;

        log::info!("[dotns] resolved via {first_source}");

        // Verify with the second source in background (non-blocking)
        {
            let cid_clone = cid.clone();
            let source_clone = first_source.clone();
            std::thread::spawn(move || {
                if let Ok((second_source, second_cid)) =
                    rx.recv_timeout(std::time::Duration::from_secs(30))
                {
                    if second_cid != cid_clone {
                        log::warn!(
                            "[dotns] CID mismatch! {source_clone}={cid_clone}, \
                             {second_source}={second_cid}"
                        );
                    } else {
                        log::info!("[dotns] CID verified by {second_source}");
                    }
                }
            });
        }

        // Fetch IPFS content and resolve owner in parallel
        let name_for_owner = name.clone();
        let owner_handle = std::thread::spawn(move || {
            host_chain::dotns::resolve_owner(&name_for_owner)
        });

        let raw_assets = host_chain::dotns::fetch_ipfs(&cid)?;
        let owner = owner_handle.join().ok().flatten();

        // Normalize: if all files share a common directory prefix (e.g. from
        // `ipfs add -r dirname/`), strip it so "dirname/index.html" becomes
        // "index.html". This matches the web version's behavior where the JS
        // CAR parser walks from the root and the SW serves with fallback paths.
        let assets = normalize_asset_paths(raw_assets);

        let file_names: Vec<String> = assets.keys().cloned().collect();
        log::info!(
            "[dotns] resolved {name}: {} file(s) — {:?}",
            file_names.len(),
            file_names
        );

        // Save the CID so the protocol handler can do on-demand IPFS fetches.
        {
            let mut cid_guard = cid_store.lock().unwrap_or_else(|e| e.into_inner());
            cid_guard.insert(name.clone(), cid.clone());
        }

        // Store all assets in the shared map so the dotapp:// protocol can serve them.
        // Evict old entries to bound memory (keep at most 8 apps cached).
        {
            let mut guard = store.lock().unwrap_or_else(|e| e.into_inner());
            const MAX_CACHED_APPS: usize = 8;
            while guard.len() >= MAX_CACHED_APPS {
                // Remove an arbitrary entry (HashMap iteration order)
                if let Some(key) = guard.keys().next().cloned() {
                    guard.remove(&key);
                }
            }
            guard.insert(name.clone(), assets);
        }

        Ok(ResolveResult {
            cid,
            owner,
            app_id: name,
            files: file_names,
        })
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

#[tauri::command]
pub async fn fetch_ipfs(cid: String) -> Result<Vec<FetchedAsset>, String> {
    tokio::task::spawn_blocking(move || {
        let assets = host_chain::dotns::fetch_ipfs(&cid)?;
        Ok(encode_assets(assets))
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/// An asset file with base64-encoded content, used by the legacy `fetch_ipfs` command.
#[derive(Serialize)]
pub struct FetchedAsset {
    pub name: String,
    /// Base64-encoded content (binary-safe for IPC).
    pub data: String,
}

/// Strip a common directory prefix from asset paths.
///
/// When content is published via `ipfs add -r dirname/`, the IPFS DAG wraps all
/// files under that directory name. The CAR parser produces keys like
/// `"dirname/index.html"` instead of `"index.html"`. This function detects a
/// single common prefix directory and strips it, so the protocol handler can
/// serve files at the paths the HTML expects.
pub fn normalize_asset_paths(assets: HashMap<String, Vec<u8>>) -> HashMap<String, Vec<u8>> {
    if assets.is_empty() || assets.contains_key("index.html") {
        return assets;
    }

    // Find the common prefix directory: all keys must start with "prefix/".
    let mut keys = assets.keys();
    let first = match keys.next() {
        Some(k) => k.clone(),
        None => return assets,
    };
    let prefix = match first.find('/') {
        Some(idx) => &first[..idx + 1], // includes trailing "/"
        None => return assets, // no directory prefix
    };

    // Check that ALL keys share this prefix
    if !assets.keys().all(|k| k.starts_with(prefix)) {
        return assets;
    }

    log::info!(
        "[dotns] stripping common prefix {:?} from {} asset path(s)",
        &prefix[..prefix.len() - 1],
        assets.len()
    );

    assets
        .into_iter()
        .map(|(k, v)| (k[prefix.len()..].to_string(), v))
        .collect()
}

pub(crate) fn encode_assets(map: HashMap<String, Vec<u8>>) -> Vec<FetchedAsset> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    map.into_iter()
        .map(|(name, data)| FetchedAsset {
            name,
            data: STANDARD.encode(&data),
        })
        .collect()
}

// ── Smoldot commands ──────────────────────────────────────

#[tauri::command]
pub fn smoldot_connect(
    genesis_hash: String,
    bridge: State<'_, SmoldotBridge>,
) -> Result<String, String> {
    let chain_type = crate::smoldot::chain_type_for_genesis(&genesis_hash)
        .ok_or_else(|| format!("Unsupported chain: {genesis_hash}"))?;

    let chain_key = genesis_hash.to_lowercase();
    bridge.send_cmd(SmoldotCmd::AddChain {
        chain_key: chain_key.clone(),
        chain_type,
    });

    Ok(chain_key)
}

#[tauri::command]
pub fn rpc_send(
    chain_key: String,
    message: String,
    bridge: State<'_, SmoldotBridge>,
) -> Result<(), String> {
    bridge.send_cmd(SmoldotCmd::Send { chain_key, message });
    Ok(())
}

// ── Wallet commands ────────────────────────────────────────

#[tauri::command]
pub fn wallet_create(wallet: State<'_, Wallet>) -> Result<String, String> {
    let mnemonic = wallet
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .create()
        .map_err(|e| e.to_string())?;
    // Zeroizing<String> -> String for IPC; the Zeroizing wrapper is dropped here.
    Ok((*mnemonic).clone())
}

#[tauri::command]
pub fn wallet_unlock(wallet: State<'_, Wallet>) -> Result<(), String> {
    wallet
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .unlock()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn wallet_lock(wallet: State<'_, Wallet>) -> Result<(), String> {
    wallet
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .lock();
    Ok(())
}

#[tauri::command]
pub fn wallet_sign(
    app_id: String,
    payload: Vec<u8>,
    wallet: State<'_, Wallet>,
) -> Result<Vec<u8>, String> {
    wallet
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .sign(&app_id, &payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn wallet_public_key(
    app_id: String,
    wallet: State<'_, Wallet>,
) -> Result<Vec<u8>, String> {
    wallet
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .app_public_key(&app_id)
        .map(|k| k.to_vec())
        .map_err(|e| e.to_string())
}
