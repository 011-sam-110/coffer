//! The named pipe server: one task per connection (one coffer-bridge.exe).
//! Each frame goes through the gate; `pair_result` waits in its own task, so
//! the connection keeps answering while the Connect prompt is open.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use coffer_bridge::{MAX_MESSAGE, frame, pipe};
use tauri::AppHandle;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

use super::AppHost;
use super::gate::{Core, Outcome, PairEnd};

/// Connections at one time; more are closed at once.
const MAX_CONNECTIONS: usize = 16;

pub fn start(app: &AppHandle, core: Arc<Core>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve(app, core).await {
            crate::log!("bridge: the pipe server stopped: {e}");
        }
    });
}

async fn serve(app: AppHandle, core: Arc<Core>) -> std::io::Result<()> {
    let sid = pipe::current_user_sid()?;
    let folder = pipe::own_folder()?;
    let name = pipe::pipe_name(&sid, &folder);
    let security = pipe::PipeSecurity::for_user(&sid)?;
    let create = |first: bool| -> std::io::Result<NamedPipeServer> {
        // Safety: `security` lives for the whole loop; the pointer is read during the call only.
        unsafe { ServerOptions::new().first_pipe_instance(first).reject_remote_clients(true).create_with_security_attributes_raw(&name, security.as_ptr()) }
    };
    // first_pipe_instance: if another program made this name first, refuse it.
    let mut server = match create(true) {
        Ok(s) => s,
        Err(e) => {
            crate::log!("bridge: could not make the pipe (another program may hold its name): {e}");
            return Err(e);
        }
    };
    crate::log!("bridge: listening");
    let open = Arc::new(AtomicUsize::new(0));
    let mut next_id = 0u64;
    loop {
        server.connect().await?;
        let connected = std::mem::replace(&mut server, create(false)?);
        if open.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
            crate::log!("bridge: too many connections; closed one");
            drop(connected);
            continue;
        }
        next_id += 1;
        open.fetch_add(1, Ordering::SeqCst);
        let (app, core, open) = (app.clone(), core.clone(), open.clone());
        tauri::async_runtime::spawn(async move {
            connection(app, core, connected, next_id).await;
            open.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

async fn connection(app: AppHandle, core: Arc<Core>, pipe_conn: NamedPipeServer, conn_id: u64) {
    {
        use std::os::windows::io::AsRawHandle;
        let who = pipe::client_exe(pipe_conn.as_raw_handle()).ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));
        crate::log!("bridge: connection {conn_id} from {}", who.as_deref().unwrap_or("an unknown program"));
    }
    let (mut rd, mut wr) = tokio::io::split(pipe_conn);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(32);
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if frame::write_async(&mut wr, msg.as_bytes(), MAX_MESSAGE).await.is_err() {
                break;
            }
        }
    });
    let mut conn = super::gate::Conn::new(conn_id);
    loop {
        let raw = match frame::read_async(&mut rd, MAX_MESSAGE).await {
            Ok(raw) => raw,
            Err(frame::FrameError::TooLarge(_)) => {
                let _ = tx.send(String::from_utf8_lossy(&coffer_bridge::error_reply(None, coffer_bridge::errors::TOO_LARGE, "A message to Coffer is limited to 1 MB.")).into_owned()).await;
                break;
            }
            Err(_) => break,
        };
        let outcome = core.handle(&AppHost(&app), &mut conn, &raw);
        match outcome {
            Outcome::Reply(reply) => {
                if tx.send(reply).await.is_err() {
                    break;
                }
            }
            Outcome::PairStarted { reply, pair_id } => {
                let (app, core) = (app.clone(), core.clone());
                let timeout = core.timeout;
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(timeout).await;
                    core.expire(&AppHost(&app), &pair_id);
                });
                if tx.send(reply).await.is_err() {
                    break;
                }
            }
            Outcome::Wait(mut wait) => {
                let tx = tx.clone();
                tauri::async_runtime::spawn(async move {
                    let end = loop {
                        let now = wait.rx.borrow().clone();
                        if now != PairEnd::Waiting {
                            break now;
                        }
                        match tokio::time::timeout_at(wait.deadline.into(), wait.rx.changed()).await {
                            Ok(Ok(())) => continue,
                            Ok(Err(_)) => break wait.rx.borrow().clone(),
                            Err(_) => break PairEnd::Timeout,
                        }
                    };
                    let _ = tx.send(wait.reply(&end)).await;
                });
            }
        }
    }
    core.conn_closed(&AppHost(&app), conn_id);
    drop(tx);
    let _ = writer.await;
    crate::log!("bridge: connection {conn_id} closed");
}
