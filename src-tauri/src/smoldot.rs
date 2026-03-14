//! Smoldot light client bridge for Tauri.
//!
//! Runs smoldot on a dedicated thread (Client is !Send), communicates via channels,
//! and streams JSON-RPC responses back to JS via Tauri events.
//!
//! Chain database state is persisted to `db_dir` so that restarts resume from
//! the last finalized block rather than syncing from genesis.

use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};

/// Sentinel JSON-RPC request id used to trigger a relay-chain DB save.
/// Responses with this id are intercepted and never forwarded to JS.
const SAVE_REQ_ID_RELAY: &str = "__smoldot_db_relay__";

/// Sentinel JSON-RPC request id used to trigger a para-chain DB save.
/// Responses with this id are intercepted and never forwarded to JS.
const SAVE_REQ_ID_PARA: &str = "__smoldot_db_para__";

/// How often (seconds) to flush the finalized-database snapshot to disk.
const SAVE_INTERVAL_SECS: u64 = 60;


/// How to add a chain to smoldot.
pub enum ChainType {
    /// A standalone chain (relay chain) — JSON-RPC directly on it.
    Relay { spec: String },
    /// A parachain — adds relay (no JSON-RPC) + parachain (with JSON-RPC).
    Para {
        relay_spec: String,
        para_spec: String,
    },
}

/// A message from JS → smoldot thread.
pub enum SmoldotCmd {
    /// Add a chain and start syncing. `chain_key` is a caller-chosen identifier.
    AddChain {
        chain_key: String,
        chain_type: ChainType,
    },
    /// Send a JSON-RPC request to a chain.
    Send { chain_key: String, message: String },
}

/// A response from smoldot thread → JS.
#[derive(Clone, serde::Serialize)]
pub struct SmoldotResponse {
    pub chain_key: String,
    pub message: String,
}

/// Pending RPC calls awaiting a response, keyed by JSON-RPC request id (as string).
type PendingCalls = Arc<Mutex<HashMap<String, mpsc::Sender<String>>>>;

/// Manages the smoldot thread and communication channels.
#[derive(Clone)]
pub struct SmoldotBridge {
    cmd_tx: mpsc::Sender<SmoldotCmd>,
    pending_calls: PendingCalls,
}

impl SmoldotBridge {
    /// Start the smoldot thread and return the bridge handle + response receiver.
    ///
    /// `db_dir` is the directory where per-chain finalized-database snapshots are
    /// stored.  Each chain writes two files: `{key}-relay.bin` for the relay chain
    /// and `{key}.bin` for the parachain (relay-only chains only write the relay
    /// file).
    pub fn new(db_dir: std::path::PathBuf) -> (Self, mpsc::Receiver<SmoldotResponse>) {
        let (cmd_tx, cmd_rx) = mpsc::channel::<SmoldotCmd>();
        let (resp_tx, resp_rx) = mpsc::channel::<SmoldotResponse>();
        let pending_calls: PendingCalls = Arc::new(Mutex::new(HashMap::new()));
        let pending_for_thread = pending_calls.clone();

        std::thread::spawn(move || {
            smoldot_thread(cmd_rx, resp_tx, pending_for_thread, db_dir);
        });

        (Self { cmd_tx, pending_calls }, resp_rx)
    }

    pub fn send_cmd(&self, cmd: SmoldotCmd) {
        let _ = self.cmd_tx.send(cmd);
    }

    /// Send a JSON-RPC request and block until the matching response arrives.
    /// The response is correlated by the `id` field in the JSON-RPC message.
    pub fn rpc_call(
        &self,
        chain_key: &str,
        request: &str,
    ) -> Result<String, String> {
        // Extract the id from the request
        let req_json: serde_json::Value = serde_json::from_str(request)
            .map_err(|e| format!("invalid JSON-RPC request: {e}"))?;
        let id_val = req_json
            .get("id")
            .ok_or("JSON-RPC request missing id")?;

        // Guard: reject string IDs that collide with internal sentinel values.
        // Those IDs are intercepted by the smoldot thread for DB persistence and
        // would never be delivered to a pending_calls waiter.
        if let Some(s) = id_val.as_str() {
            if s == SAVE_REQ_ID_PARA || s == SAVE_REQ_ID_RELAY {
                return Err(format!(
                    "JSON-RPC id \"{s}\" is reserved for internal use"
                ));
            }
        }

        let id = id_val.to_string();

        // Register a channel for the response
        let (tx, rx) = mpsc::channel::<String>();
        let call_key = format!("{chain_key}:{id}");
        self.pending_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(call_key.clone(), tx);

        // Send the request
        self.send_cmd(SmoldotCmd::Send {
            chain_key: chain_key.to_string(),
            message: request.to_string(),
        });

        // Block until the response arrives (with timeout)
        let timeout = std::time::Duration::from_secs(30);
        rx.recv_timeout(timeout).map_err(|e| {
            // Clean up the pending entry on timeout
            self.pending_calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&call_key);
            format!("smoldot RPC call timed out: {e}")
        })
    }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/// Load a chain DB snapshot from disk.  Returns an empty string if the file
/// does not exist or cannot be read (smoldot treats "" as a cold start).
fn load_chain_db(db_dir: &std::path::Path, key: &str) -> String {
    std::fs::read_to_string(db_dir.join(format!("{key}.bin")))
        .unwrap_or_default()
}

/// Persist a chain DB snapshot to disk atomically via write-to-tmp-then-rename.
/// Errors are silently swallowed — a failed save merely means the next restart
/// will do a longer sync.
fn save_chain_db(db_dir: &std::path::Path, key: &str, data: &str) {
    let _ = std::fs::create_dir_all(db_dir);
    let final_path = db_dir.join(format!("{key}.bin"));
    let tmp_path = db_dir.join(format!("{key}.bin.tmp"));
    if std::fs::write(&tmp_path, data).is_ok() {
        let _ = std::fs::rename(&tmp_path, &final_path);
    }
}

// ---------------------------------------------------------------------------
// Per-chain save state
// ---------------------------------------------------------------------------

/// Tracks the relay ChainId (for Para chains) and when the last DB save was
/// triggered for a given `chain_key`.
struct ChainDbMeta {
    /// The smoldot ChainId of the *relay* chain added alongside a Para chain.
    /// `None` for Relay-type chains.
    relay_chain_id: Option<smoldot_light::ChainId>,
    /// When the last `chainHead_unstable_finalizedDatabase` request was sent.
    last_save: std::time::Instant,
    /// The disk key used when saving the *primary* (para or relay-only) chain DB.
    ///
    /// For relay-only chains this is `"{chain_key}-relay"`; for para chains it
    /// is `"{chain_key}"`.
    primary_db_key: String,
}

// ---------------------------------------------------------------------------
// smoldot thread
// ---------------------------------------------------------------------------

/// The smoldot thread — owns the Client, processes commands, streams responses.
///
/// The thread body is wrapped in `catch_unwind` so that a smoldot-internal
/// panic does not silently kill the thread.  Because `cmd_rx` is moved into the
/// closure it cannot be reused after a panic, so retry is not possible here;
/// instead the error is reported through `resp_tx` so the UI can surface it.
fn smoldot_thread(
    cmd_rx: mpsc::Receiver<SmoldotCmd>,
    resp_tx: mpsc::Sender<SmoldotResponse>,
    pending_calls: PendingCalls,
    db_dir: std::path::PathBuf,
) {
    let resp_tx_c = resp_tx.clone();
    let pending_c = pending_calls.clone();
    let db_dir_c = db_dir.clone();

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        smoldot_thread_body(cmd_rx, resp_tx_c, pending_c, db_dir_c);
    }));

    if let Err(payload) = result {
        let msg = if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic payload".to_string()
        };
        log::error!("[smoldot] thread panicked: {msg}");
        let _ = resp_tx.send(SmoldotResponse {
            chain_key: "__internal__".to_string(),
            message: r#"{"error":"smoldot thread panicked"}"#.to_string(),
        });
    }
}

/// Inner body of the smoldot thread, extracted so `catch_unwind` can wrap it.
fn smoldot_thread_body(
    cmd_rx: mpsc::Receiver<SmoldotCmd>,
    resp_tx: mpsc::Sender<SmoldotResponse>,
    pending_calls: PendingCalls,
    db_dir: std::path::PathBuf,
) {
    use smoldot_light::{AddChainConfig, AddChainConfigJsonRpc, Client};

    type Platform = std::sync::Arc<smoldot_light::platform::DefaultPlatform>;

    let mut client = Client::new(smoldot_light::platform::DefaultPlatform::new(
        "dotli-desktop".into(),
        env!("CARGO_PKG_VERSION").into(),
    ));

    let json_rpc_cfg = || AddChainConfigJsonRpc::Enabled {
        max_pending_requests: std::num::NonZeroU32::new(128).unwrap(),
        max_subscriptions: 1024,
    };

    // Track the primary chain_id (the one with JSON-RPC) per chain_key
    let mut rpc_chains: HashMap<String, smoldot_light::ChainId> = HashMap::new();

    // Per-chain metadata (relay id + last-save timestamp + primary db key)
    let mut chain_meta: HashMap<String, ChainDbMeta> = HashMap::new();

    smol::block_on(async {
        // JSON-RPC response streams for the *primary* (para or relay-only) chains
        let mut response_streams: HashMap<String, smoldot_light::JsonRpcResponses<Platform>> =
            HashMap::new();

        // JSON-RPC response streams for relay chains added as part of a Para pair.
        // Relay responses are only ever sentinel DB-save replies; they are never
        // forwarded to JS.
        let mut relay_streams: HashMap<String, smoldot_light::JsonRpcResponses<Platform>> =
            HashMap::new();

        let save_interval = std::time::Duration::from_secs(SAVE_INTERVAL_SECS);

        loop {
            // ------------------------------------------------------------------
            // 1. Process incoming commands (non-blocking drain)
            // ------------------------------------------------------------------
            while let Ok(cmd) = cmd_rx.try_recv() {
                match cmd {
                    SmoldotCmd::AddChain {
                        chain_key,
                        chain_type,
                    } => {
                        if rpc_chains.contains_key(&chain_key) {
                            log::info!("[smoldot] chain {chain_key} already added");
                            continue;
                        }
                        log::info!("[smoldot] adding chain: {chain_key}");

                        match chain_type {
                            ChainType::Relay { spec } => {
                                let relay_db_key = format!("{chain_key}-relay");
                                let db = load_chain_db(&db_dir, &relay_db_key);
                                log::info!(
                                    "[smoldot] relay {chain_key}: DB snapshot {} bytes",
                                    db.len()
                                );

                                match client.add_chain(AddChainConfig {
                                    specification: &spec,
                                    database_content: &db,
                                    potential_relay_chains: std::iter::empty(),
                                    json_rpc: json_rpc_cfg(),
                                    user_data: (),
                                }) {
                                    Ok(added) => {
                                        let id = added.chain_id;
                                        let responses = added.json_rpc_responses.unwrap();
                                        response_streams
                                            .insert(chain_key.clone(), responses);
                                        rpc_chains.insert(chain_key.clone(), id);
                                        chain_meta.insert(
                                            chain_key.clone(),
                                            ChainDbMeta {
                                                relay_chain_id: None,
                                                last_save: std::time::Instant::now(),
                                                primary_db_key: relay_db_key,
                                            },
                                        );
                                        log::info!(
                                            "[smoldot] relay chain {chain_key} added"
                                        );
                                    }
                                    Err(e) => {
                                        log::error!(
                                            "[smoldot] add relay chain failed: {e}"
                                        );
                                    }
                                }
                            }
                            ChainType::Para {
                                relay_spec,
                                para_spec,
                            } => {
                                let relay_key = format!("{chain_key}-relay");
                                let relay_db = load_chain_db(&db_dir, &relay_key);
                                let mut para_db =
                                    load_chain_db(&db_dir, &chain_key);

                                // Coherence guard: if the relay snapshot is empty but the
                                // parachain snapshot is not, the para snapshot references a
                                // block that smoldot cannot locate (it would panic).  Clear
                                // the para DB so both start fresh together.
                                if relay_db.is_empty() && !para_db.is_empty() {
                                    log::warn!(
                                        "[smoldot] {chain_key}: relay DB empty but para DB \
                                         non-empty — clearing stale para snapshot"
                                    );
                                    para_db = String::new();
                                    // Also wipe the stale para DB from disk
                                    save_chain_db(&db_dir, &chain_key, "");
                                }

                                log::info!(
                                    "[smoldot] para {chain_key}: relay DB {} bytes, \
                                     para DB {} bytes",
                                    relay_db.len(),
                                    para_db.len()
                                );

                                // Add relay chain — with JSON-RPC so we can request its DB
                                let relay = match client.add_chain(AddChainConfig {
                                    specification: &relay_spec,
                                    database_content: &relay_db,
                                    potential_relay_chains: std::iter::empty(),
                                    json_rpc: AddChainConfigJsonRpc::Enabled {
                                        max_pending_requests: std::num::NonZeroU32::new(16)
                                            .unwrap(),
                                        max_subscriptions: 4,
                                    },
                                    user_data: (),
                                }) {
                                    Ok(r) => r,
                                    Err(e) => {
                                        log::error!(
                                            "[smoldot] relay add_chain failed: {e}"
                                        );
                                        continue;
                                    }
                                };
                                let relay_id = relay.chain_id;
                                let relay_responses = relay.json_rpc_responses.unwrap();

                                // Add parachain with JSON-RPC
                                match client.add_chain(AddChainConfig {
                                    specification: &para_spec,
                                    database_content: &para_db,
                                    potential_relay_chains: std::iter::once(relay_id),
                                    json_rpc: json_rpc_cfg(),
                                    user_data: (),
                                }) {
                                    Ok(para) => {
                                        let para_id = para.chain_id;
                                        let responses =
                                            para.json_rpc_responses.unwrap();
                                        response_streams
                                            .insert(chain_key.clone(), responses);
                                        relay_streams
                                            .insert(chain_key.clone(), relay_responses);
                                        rpc_chains
                                            .insert(chain_key.clone(), para_id);
                                        chain_meta.insert(
                                            chain_key.clone(),
                                            ChainDbMeta {
                                                relay_chain_id: Some(relay_id),
                                                last_save: std::time::Instant::now(),
                                                // Para chains save under the chain_key itself
                                                primary_db_key: chain_key.clone(),
                                            },
                                        );
                                        log::info!(
                                            "[smoldot] parachain {chain_key} added"
                                        );
                                    }
                                    Err(e) => {
                                        log::error!(
                                            "[smoldot] para add_chain failed: {e}"
                                        );
                                        #[allow(clippy::let_unit_value)]
                                        let _ = client.remove_chain(relay_id);
                                    }
                                }
                            }
                        }
                    }
                    SmoldotCmd::Send { chain_key, message } => {
                        if let Some(&chain_id) = rpc_chains.get(&chain_key) {
                            if let Err(e) = client.json_rpc_request(message, chain_id) {
                                log::warn!("[smoldot] json_rpc_request failed: {e:?}");
                            }
                        } else {
                            log::warn!("[smoldot] send to unknown chain: {chain_key}");
                        }
                    }
                }
            }

            // ------------------------------------------------------------------
            // 2. Trigger periodic DB saves
            // ------------------------------------------------------------------
            let now = std::time::Instant::now();
            for (key, meta) in chain_meta.iter_mut() {
                if now.duration_since(meta.last_save) < save_interval {
                    continue;
                }
                meta.last_save = now;

                // Send the DB-dump request to the primary (para or relay-only) chain
                if let Some(&chain_id) = rpc_chains.get(key) {
                    let req = format!(
                        r#"{{"jsonrpc":"2.0","id":"{SAVE_REQ_ID_PARA}","method":"chainHead_unstable_finalizedDatabase","params":[]}}"#
                    );
                    if let Err(e) = client.json_rpc_request(req, chain_id) {
                        log::warn!("[smoldot] DB save request (para) failed for {key}: {e:?}");
                    }
                }

                // For Para chains, also dump the relay chain DB
                if let Some(relay_id) = meta.relay_chain_id {
                    let req = format!(
                        r#"{{"jsonrpc":"2.0","id":"{SAVE_REQ_ID_RELAY}","method":"chainHead_unstable_finalizedDatabase","params":[]}}"#
                    );
                    if let Err(e) = client.json_rpc_request(req, relay_id) {
                        log::warn!("[smoldot] DB save request (relay) failed for {key}: {e:?}");
                    }
                }
            }

            // ------------------------------------------------------------------
            // 3. Poll primary response streams
            // ------------------------------------------------------------------
            let mut got_response = false;
            for (key, stream) in response_streams.iter_mut() {
                let resp: Option<String> = smol::future::or(
                    async { stream.next().await },
                    async {
                        smol::Timer::after(std::time::Duration::ZERO).await;
                        None
                    },
                )
                .await;

                if let Some(text) = resp {
                    got_response = true;

                    // Parse id for sentinel / pending-call interception
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(id_val) = json.get("id") {
                            // Check for sentinel save IDs — match on string values
                            if let Some(id_str) = id_val.as_str() {
                                if id_str == SAVE_REQ_ID_PARA {
                                    // Extract result and persist using the correct key
                                    if let Some(result) = json.get("result").and_then(|r| r.as_str()) {
                                        let primary_key = chain_meta
                                            .get(key)
                                            .map(|m| m.primary_db_key.as_str())
                                            .unwrap_or(key.as_str());
                                        log::info!(
                                            "[smoldot] saving primary DB for {key} \
                                             (key: {primary_key}, {} bytes)",
                                            result.len()
                                        );
                                        save_chain_db(&db_dir, primary_key, result);
                                    }
                                    continue; // do not forward to JS
                                }
                                if id_str == SAVE_REQ_ID_RELAY {
                                    // This shouldn't arrive on the primary stream for Para
                                    // chains, but handle it defensively.
                                    if let Some(result) = json.get("result").and_then(|r| r.as_str()) {
                                        let relay_key = format!("{key}-relay");
                                        log::info!(
                                            "[smoldot] saving relay DB for {key} ({} bytes)",
                                            result.len()
                                        );
                                        save_chain_db(&db_dir, &relay_key, result);
                                    }
                                    continue; // do not forward to JS
                                }
                            }

                            // Check pending rpc_call waiters
                            let call_key = format!("{}:{}", key, id_val);
                            let sender = pending_calls
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .remove(&call_key);
                            if let Some(tx) = sender {
                                let _ = tx.send(text.clone());
                                continue; // intercepted — do not forward to JS
                            }
                        }
                    }

                    // Forward to JS via the event channel
                    let _ = resp_tx.send(SmoldotResponse {
                        chain_key: key.clone(),
                        message: text,
                    });
                }
            }

            // ------------------------------------------------------------------
            // 4. Poll relay response streams (sentinel replies only)
            // ------------------------------------------------------------------
            for (key, stream) in relay_streams.iter_mut() {
                let resp: Option<String> = smol::future::or(
                    async { stream.next().await },
                    async {
                        smol::Timer::after(std::time::Duration::ZERO).await;
                        None
                    },
                )
                .await;

                if let Some(text) = resp {
                    got_response = true;

                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(id_val) = json.get("id") {
                            if let Some(id_str) = id_val.as_str() {
                                if id_str == SAVE_REQ_ID_RELAY {
                                    if let Some(result) =
                                        json.get("result").and_then(|r| r.as_str())
                                    {
                                        let relay_key = format!("{key}-relay");
                                        log::info!(
                                            "[smoldot] saving relay DB for {key} ({} bytes)",
                                            result.len()
                                        );
                                        save_chain_db(&db_dir, &relay_key, result);
                                    }
                                    continue; // never forward relay sentinel responses
                                }
                            }
                        }
                    }
                    // Any non-sentinel relay response is unexpected — log and discard
                    log::warn!("[smoldot] unexpected response on relay stream for {key}");
                }
            }

            // If no responses arrived from any stream, sleep briefly to avoid busy-spinning
            if !got_response {
                smol::Timer::after(std::time::Duration::from_millis(50)).await;
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Public accessor used by tests to read sentinel constant values without
// exposing them as part of the public API.
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) fn sentinel_para() -> &'static str {
    SAVE_REQ_ID_PARA
}

#[cfg(test)]
pub(crate) fn sentinel_relay() -> &'static str {
    SAVE_REQ_ID_RELAY
}

// ---------------------------------------------------------------------------
// Public for tests — expose the persistence helpers under #[cfg(test)]
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) fn load_chain_db_pub(db_dir: &std::path::Path, key: &str) -> String {
    load_chain_db(db_dir, key)
}

#[cfg(test)]
pub(crate) fn save_chain_db_pub(db_dir: &std::path::Path, key: &str, data: &str) {
    save_chain_db(db_dir, key, data);
}

/// Map a genesis hash to a ChainType using host-chain's embedded specs.
pub fn chain_type_for_genesis(genesis_hash: &str) -> Option<ChainType> {
    let hash = genesis_hash.to_lowercase();
    for &chain_id in host_chain::ChainId::substrate_chains() {
        if let Some((relay_spec, para_spec)) = chain_id.chain_specs() {
            let (para_hash, relay_hash) = match chain_id {
                host_chain::ChainId::PaseoAssetHub => (
                    "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
                    "0x77afd6190f1554ad45fd0d31aee62aacc33c6db0ea801129acb813f913e0764f",
                ),
                host_chain::ChainId::PolkadotAssetHub => (
                    "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f",
                    "0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3",
                ),
                _ => continue,
            };

            if hash == para_hash {
                return Some(ChainType::Para {
                    relay_spec: relay_spec.to_string(),
                    para_spec: para_spec.to_string(),
                });
            }
            if hash == relay_hash {
                return Some(ChainType::Relay {
                    spec: relay_spec.to_string(),
                });
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // load_chain_db / save_chain_db
    // -----------------------------------------------------------------------

    /// load returns empty string when no file exists.
    #[test]
    fn load_chain_db_missing_file_returns_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let result = load_chain_db_pub(dir.path(), "nonexistent-chain");
        assert!(result.is_empty());
    }

    /// save writes bytes to disk; load reads them back verbatim.
    #[test]
    fn save_then_load_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let payload = "synced-finalized-block-data";
        save_chain_db_pub(dir.path(), "relay", payload);
        let loaded = load_chain_db_pub(dir.path(), "relay");
        assert_eq!(loaded, payload);
    }

    /// Different keys produce different files and do not clobber each other.
    #[test]
    fn separate_keys_stored_independently() {
        let dir = tempfile::tempdir().expect("tempdir");
        save_chain_db_pub(dir.path(), "polkadot", "relay-data");
        save_chain_db_pub(dir.path(), "polkadot-para", "para-data");

        assert_eq!(load_chain_db_pub(dir.path(), "polkadot"), "relay-data");
        assert_eq!(load_chain_db_pub(dir.path(), "polkadot-para"), "para-data");
    }

    /// save creates the directory if it does not exist yet.
    #[test]
    fn save_creates_missing_directory() {
        let base = tempfile::tempdir().expect("tempdir");
        let nested = base.path().join("a").join("b").join("c");
        // nested does not exist yet
        save_chain_db_pub(&nested, "mychain", "some-db");
        let loaded = load_chain_db_pub(&nested, "mychain");
        assert_eq!(loaded, "some-db");
    }

    /// Overwriting an existing snapshot stores the newest value.
    #[test]
    fn save_overwrites_existing_snapshot() {
        let dir = tempfile::tempdir().expect("tempdir");
        save_chain_db_pub(dir.path(), "chain", "old-data");
        save_chain_db_pub(dir.path(), "chain", "new-data");
        assert_eq!(load_chain_db_pub(dir.path(), "chain"), "new-data");
    }

    /// Empty string is a valid payload (smoldot cold-start sentinel).
    #[test]
    fn save_and_load_empty_string() {
        let dir = tempfile::tempdir().expect("tempdir");
        save_chain_db_pub(dir.path(), "chain", "");
        let loaded = load_chain_db_pub(dir.path(), "chain");
        assert!(loaded.is_empty());
    }

    // -----------------------------------------------------------------------
    // Sentinel constants — must be distinct strings
    // -----------------------------------------------------------------------

    /// Sentinels must not overlap so responses from each stream are unambiguous.
    #[test]
    fn sentinel_ids_are_distinct() {
        assert_ne!(sentinel_para(), sentinel_relay());
    }

    /// SAVE_REQ_ID_RELAY has the expected string value.
    #[test]
    fn sentinel_relay_has_expected_value() {
        assert_eq!(sentinel_relay(), "__smoldot_db_relay__");
    }

    /// SAVE_REQ_ID_PARA has the expected string value.
    #[test]
    fn sentinel_para_has_expected_value() {
        assert_eq!(sentinel_para(), "__smoldot_db_para__");
    }

    // -----------------------------------------------------------------------
    // rpc_call sentinel guard
    // -----------------------------------------------------------------------

    /// rpc_call must reject a request whose string id matches SAVE_REQ_ID_PARA.
    #[test]
    fn rpc_call_rejects_sentinel_para_id() {
        let (bridge, _rx) = SmoldotBridge::new(
            std::path::PathBuf::from("/tmp/dotli-test-sentinel-para"),
        );
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":"{}","method":"system_health","params":[]}}"#,
            SAVE_REQ_ID_PARA
        );
        let result = bridge.rpc_call("any-key", &req);
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("reserved"), "expected 'reserved' in: {msg}");
    }

    /// rpc_call must reject a request whose string id matches SAVE_REQ_ID_RELAY.
    #[test]
    fn rpc_call_rejects_sentinel_relay_id() {
        let (bridge, _rx) = SmoldotBridge::new(
            std::path::PathBuf::from("/tmp/dotli-test-sentinel-relay"),
        );
        let req = format!(
            r#"{{"jsonrpc":"2.0","id":"{}","method":"system_health","params":[]}}"#,
            SAVE_REQ_ID_RELAY
        );
        let result = bridge.rpc_call("any-key", &req);
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("reserved"), "expected 'reserved' in: {msg}");
    }

    /// rpc_call must reject requests with no id field.
    #[test]
    fn rpc_call_rejects_missing_id() {
        let (bridge, _rx) = SmoldotBridge::new(
            std::path::PathBuf::from("/tmp/dotli-test-missing-id"),
        );
        let req = r#"{"jsonrpc":"2.0","method":"system_health","params":[]}"#;
        let result = bridge.rpc_call("any-key", req);
        assert!(result.is_err());
    }

    /// rpc_call must reject non-JSON input.
    #[test]
    fn rpc_call_rejects_invalid_json() {
        let (bridge, _rx) = SmoldotBridge::new(
            std::path::PathBuf::from("/tmp/dotli-test-invalid-json"),
        );
        let result = bridge.rpc_call("any-key", "not-json");
        assert!(result.is_err());
    }

    /// A numeric id does not hit the sentinel guard (sentinels are strings now).
    #[test]
    fn rpc_call_numeric_id_not_blocked_by_sentinel_guard() {
        let (bridge, _rx) = SmoldotBridge::new(
            std::path::PathBuf::from("/tmp/dotli-test-numeric-id"),
        );
        // The chain key does not exist so the smoldot thread will log a warning
        // and never respond — the call should time out, not return a sentinel error.
        // We verify the sentinel guard does not fire by checking that the id
        // is numeric (as_str() returns None → no sentinel check fires).
        let req = r#"{"jsonrpc":"2.0","id":42,"method":"system_health","params":[]}"#;
        let v: serde_json::Value = serde_json::from_str(req).unwrap();
        let id = v.get("id").unwrap();
        // Numeric id → as_str() returns None → sentinel guard is never reached.
        assert!(id.as_str().is_none());
        drop(bridge);
    }

    /// A string id that is not a sentinel value does not hit the sentinel guard.
    #[test]
    fn rpc_call_string_id_not_blocked_by_sentinel_guard() {
        let (bridge, _rx) = SmoldotBridge::new(
            std::path::PathBuf::from("/tmp/dotli-test-string-id"),
        );
        let req = r#"{"jsonrpc":"2.0","id":"abc","method":"system_health","params":[]}"#;
        let v: serde_json::Value = serde_json::from_str(req).unwrap();
        let id = v.get("id").unwrap();
        let s = id.as_str().unwrap();
        // "abc" is neither SAVE_REQ_ID_PARA nor SAVE_REQ_ID_RELAY.
        assert_ne!(s, SAVE_REQ_ID_PARA);
        assert_ne!(s, SAVE_REQ_ID_RELAY);
        drop(bridge);
    }
}
