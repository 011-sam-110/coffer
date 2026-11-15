//! coffer-bridge.exe: the native messaging host of the Coffer extension.
//!
//! Chrome (or Edge) starts it when the extension calls `connectNative`, with
//! the extension's origin as the first argument. It reads framed messages on
//! stdin and passes each one, unchanged, to the Coffer in its own folder over
//! the named pipe (`coffer_bridge::pipe`); each frame from Coffer goes back
//! on stdout. It keeps no secrets and no state, and exits when stdin closes.
//!
//! When no Coffer answers, it starts `coffer.exe --hidden` from its own
//! folder and waits up to 6 seconds for the pipe. If there is still no pipe,
//! it answers every message with `{"error":"not_running"}`.
//!
//! `coffer-bridge.exe --pipe-name` prints the pipe name and exits (tests and
//! support).

#[cfg(windows)]
fn main() {
    if std::env::args().any(|a| a == "--pipe-name") {
        match host::pipe() {
            Ok((name, _)) => println!("{name}"),
            Err(e) => {
                eprintln!("coffer-bridge: {e}");
                std::process::exit(1);
            }
        }
        return;
    }
    std::process::exit(host::run());
}

#[cfg(not(windows))]
fn main() {
    eprintln!("coffer-bridge runs on Windows only.");
    std::process::exit(1);
}

#[cfg(windows)]
mod host {
    use std::io::{self, Write};
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use coffer_bridge::frame::{self, FrameError};
    use coffer_bridge::{MAX_MESSAGE, errors, error_reply, pipe};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_PIPE_BUSY: i32 = 231;
    /// How long the bridge waits for a Coffer it started.
    const START_WAIT: Duration = Duration::from_secs(6);

    // CreateProcess flags: no console, own process group, and out of Chrome's
    // job object (so Coffer keeps running when Chrome closes the bridge).
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

    fn log(message: &str) {
        // Chrome keeps a native host's stderr in its own log (chrome_debug.log).
        eprintln!("coffer-bridge: {message}");
    }

    /// The pipe name and the folder of this bridge.
    pub fn pipe() -> io::Result<(String, PathBuf)> {
        let folder = pipe::own_folder()?;
        let sid = pipe::current_user_sid()?;
        Ok((pipe::pipe_name(&sid, &folder), folder))
    }

    enum Link {
        Up(NamedPipeClient),
        Down(&'static str, &'static str),
    }

    fn open(name: &str) -> io::Result<NamedPipeClient> {
        let end = Instant::now() + Duration::from_secs(2);
        loop {
            match ClientOptions::new().open(name) {
                Ok(c) => return Ok(c),
                // Every instance is busy: Coffer makes the next one in a moment.
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && Instant::now() < end => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => return Err(e),
            }
        }
    }

    fn start_coffer(folder: &Path) {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        let exe = folder.join("coffer.exe");
        if !exe.is_file() {
            log("there is no coffer.exe next to the bridge");
            return;
        }
        let spawn = |flags: u32| Command::new(&exe).arg("--hidden").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(flags).spawn();
        let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
        // A job without "breakaway OK" refuses CREATE_BREAKAWAY_FROM_JOB: start it inside the job then.
        match spawn(base | CREATE_BREAKAWAY_FROM_JOB).or_else(|_| spawn(base)) {
            Ok(_) => log("started Coffer"),
            Err(e) => log(&format!("could not start Coffer: {e}")),
        }
    }

    async fn connect(name: &str, folder: &Path) -> Link {
        let client = match open(name) {
            Ok(c) => c,
            Err(e) if e.raw_os_error() == Some(ERROR_FILE_NOT_FOUND) => {
                start_coffer(folder);
                let end = Instant::now() + START_WAIT;
                loop {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    match open(name) {
                        Ok(c) => break c,
                        Err(_) if Instant::now() < end => {}
                        Err(_) => return Link::Down(errors::NOT_RUNNING, "Coffer is not running."),
                    }
                }
            }
            Err(e) => {
                log(&format!("the pipe did not open: {e}"));
                return Link::Down(errors::NOT_RUNNING, "Coffer is not running.");
            }
        };
        // Only the Coffer in this folder may answer.
        match pipe::server_exe(client.as_raw_handle()) {
            Ok(exe) if pipe::exe_in_folder(&exe, folder) => Link::Up(client),
            Ok(exe) => {
                log(&format!("refused the pipe: its server is {}", exe.display()));
                Link::Down(errors::WRONG_SERVER, "Another program holds Coffer's pipe. Restart Coffer.")
            }
            Err(e) => {
                log(&format!("could not check the pipe's server: {e}"));
                Link::Down(errors::WRONG_SERVER, "Coffer's pipe could not be checked.")
            }
        }
    }

    enum Done {
        Stdin,
        Pipe,
    }

    enum In {
        Msg(Vec<u8>),
        /// Chrome sent a frame over 1 MB; the bridge dropped it.
        TooLarge,
    }

    pub fn run() -> i32 {
        let (name, folder) = match pipe() {
            Ok(p) => p,
            Err(e) => {
                log(&e.to_string());
                return 1;
            }
        };
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                log(&e.to_string());
                return 1;
            }
        };

        // stdout: one writer thread, so frames never interleave.
        let (out_tx, out_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let writer = std::thread::spawn(move || {
            let mut stdout = io::stdout().lock();
            for msg in out_rx {
                if frame::write(&mut stdout, &msg, MAX_MESSAGE).is_err() {
                    break;
                }
            }
            let _ = stdout.flush();
        });

        // stdin: one reader thread; a closed stdin ends the bridge.
        let (in_tx, mut in_rx) = tokio::sync::mpsc::channel::<In>(32);
        std::thread::spawn(move || {
            let mut stdin = io::stdin().lock();
            loop {
                let next = match frame::read(&mut stdin, MAX_MESSAGE) {
                    Ok(msg) => In::Msg(msg),
                    Err(FrameError::TooLarge(n)) => {
                        if frame::skip(&mut stdin, n).is_err() {
                            break;
                        }
                        In::TooLarge
                    }
                    Err(_) => break,
                };
                if in_tx.blocking_send(next).is_err() {
                    break;
                }
            }
        });
        const TOO_LARGE_IN: &str = "A message to Coffer is limited to 1 MB.";

        let code = rt.block_on(async move {
            match connect(&name, &folder).await {
                Link::Down(code, message) => {
                    // Answer each message until Chrome closes stdin.
                    while let Some(next) = in_rx.recv().await {
                        let _ = out_tx.send(match next {
                            In::Msg(msg) => error_reply(Some(&msg), code, message),
                            In::TooLarge => error_reply(None, errors::TOO_LARGE, TOO_LARGE_IN),
                        });
                    }
                    0
                }
                Link::Up(client) => {
                    let coffer_pid = pipe::server_pid(client.as_raw_handle()).ok();
                    let (mut rd, mut wr) = tokio::io::split(client);
                    let (done_tx, mut done_rx) = tokio::sync::mpsc::channel::<Done>(2);
                    let d1 = done_tx.clone();
                    let out_too_large = out_tx.clone();
                    tokio::spawn(async move {
                        while let Some(next) = in_rx.recv().await {
                            let msg = match next {
                                In::Msg(msg) => msg,
                                In::TooLarge => {
                                    let _ = out_too_large.send(error_reply(None, errors::TOO_LARGE, TOO_LARGE_IN));
                                    continue;
                                }
                            };
                            // A call can open a Coffer window (Connect prompt, unlock): let it come to the front.
                            if let Some(pid) = coffer_pid {
                                pipe::allow_foreground(pid);
                            }
                            if frame::write_async(&mut wr, &msg, MAX_MESSAGE).await.is_err() {
                                break;
                            }
                        }
                        let _ = d1.send(Done::Stdin).await;
                    });
                    tokio::spawn(async move {
                        loop {
                            match frame::read_async(&mut rd, MAX_MESSAGE).await {
                                Ok(msg) => {
                                    if out_tx.send(msg).is_err() {
                                        break;
                                    }
                                }
                                // Coffer caps its own replies; one over 1 MB would break Chrome's port.
                                Err(FrameError::TooLarge(_)) => {
                                    let _ = out_tx.send(error_reply(None, errors::TOO_LARGE, "Coffer's answer was over 1 MB."));
                                    break;
                                }
                                Err(_) => break,
                            }
                        }
                        let _ = done_tx.send(Done::Pipe).await;
                    });
                    match done_rx.recv().await {
                        Some(Done::Pipe) => log("Coffer closed the pipe"),
                        _ => {}
                    }
                    0
                }
            }
        });
        // Every sender of stdout is gone with the runtime: the writer ends after
        // the frames it holds. (The stdin thread may still wait on Chrome.)
        drop(rt);
        let _ = writer.join();
        code
    }
}
