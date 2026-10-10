//! Localhost WebSocket transport page -> Host (lane nt-fastipc). Replaces the ~16 MB/s Tauri `invoke(cmd, Uint8Array)` body path
//! (WKWebView -> wry `ipc://` custom scheme: ~800 ms per 13.6 MB) for the render command stream.
//!
//! WHY WebSocket (not HTTP POST): ONE persistent, ORDERED, binary-framed connection = exactly the serial pipe the command stream needs
//! (create-before-use order is load-bearing); reports come back in request order, so N messages can be in flight with no ids.
//! Page origin is `http://127.0.0.1:<vite>`, we listen on another port: WebSocket handshakes carry `Origin` but have NO CORS preflight
//! (the server decides), whereas a cross-port `fetch` POST of `application/octet-stream` is a non-simple request -> OPTIONS preflight
//! + CORS headers on every response. http:// page -> ws://127.0.0.1 is not mixed content (and 127.0.0.1 is a potentially-trustworthy origin).
//!
//! Security: bound to 127.0.0.1 ONLY (not configurable), random 128-bit per-launch token required in the handshake URL (`?t=`),
//! `Origin` must equal the game page origin (`--ipc-check-origin`), peer must be loopback. Any local page could otherwise drive the GPU.
//!
//! Per connection: RX thread (reads frames; BufReader, so big frames are not read 4 KiB per syscall) -> bounded channel
//! (`--ipc-queue`) -> APPLY thread (`apply::apply_logged` under the shared `Mutex<Host>`, replies with the report bytes).
//! The next message is received WHILE the previous one is applied (that is the point of pipelining). Never launched by the lane that wrote it.
use crate::{apply::apply_logged, config::GameConfig, shared::Shared};
use gaia_render_host::Host;
use std::{
    io::{self, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    Message, WebSocket,
    handshake::server::{ErrorResponse, Request, Response},
    http,
    protocol::{Role, WebSocketConfig},
};

#[derive(Clone, Debug)]
pub struct Opts {
    /// 0 = OS picks an ephemeral port
    pub port: u16,
    /// required `Origin` header (None = not checked)
    pub origin: Option<String>,
    pub max_message: usize,
    /// messages buffered between the RX and APPLY thread
    pub queue: usize,
    pub read_buf: usize,
    pub handshake: Duration,
    pub stats_every: Duration,
}

pub struct IpcWs {
    listener: TcpListener,
    pub port: u16,
    pub token: String,
    opts: Opts,
}

fn hex_token() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| format!("ipc-ws token: OS random failed: {e}"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

impl IpcWs {
    /// Bind 127.0.0.1:<port> + mint the token. Called BEFORE the webview exists (port+token go into its init script);
    /// connections made before `serve` simply wait in the kernel backlog.
    pub fn bind(cfg: &GameConfig) -> Result<Self, String> {
        let opts = Opts {
            port: cfg.ipc_port,
            origin: cfg.ipc_check_origin.then(|| cfg.url.origin().ascii_serialization()),
            max_message: cfg.ipc_max_message,
            queue: cfg.ipc_queue.max(1),
            read_buf: cfg.ipc_read_buf,
            handshake: cfg.ipc_handshake,
            stats_every: cfg.ipc_stats_every,
        };
        let listener = TcpListener::bind(("127.0.0.1", opts.port)).map_err(|e| format!("ipc-ws bind 127.0.0.1:{}: {e}", opts.port))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        Ok(Self { listener, port, token: hex_token()?, opts })
    }

    /// Start accepting (thread `gaia-ipc-accept`). `host` = the SAME `Arc<Mutex<Host>>` the render thread and the invoke command use.
    pub fn serve(self, host: Arc<Mutex<Host>>, shared: Arc<Shared>) -> io::Result<()> {
        eprintln!(
            "[ipc-ws] listening 127.0.0.1:{} (origin check: {:?}, max message {} MiB, queue {}, read buf {} KiB)",
            self.port,
            self.opts.origin,
            self.opts.max_message >> 20,
            self.opts.queue,
            self.opts.read_buf >> 10
        );
        thread::Builder::new().name("gaia-ipc-accept".into()).spawn(move || {
            let mut next_id = 0u64;
            for conn in self.listener.incoming() {
                let stream = match conn {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[ipc-ws] accept failed: {e}");
                        continue;
                    }
                };
                next_id += 1;
                let (id, token, opts, host, shared) = (next_id, self.token.clone(), self.opts.clone(), host.clone(), shared.clone());
                let spawned = thread::Builder::new().name(format!("gaia-ipc-rx#{id}")).spawn(move || {
                    if let Err(e) = connection(stream, id, &token, &opts, host, shared) {
                        eprintln!("[ipc-ws] conn#{id} ended: {e}");
                    }
                });
                if let Err(e) = spawned {
                    eprintln!("[ipc-ws] cannot spawn connection thread: {e}");
                }
            }
        })?;
        Ok(())
    }
}

/// Read side = buffered; write side = the raw socket during the handshake only, then muted (the TX socket owns all writes,
/// so a reader-generated pong/close can never interleave into a half-written report frame).
struct Duplex {
    r: BufReader<TcpStream>,
    w: TcpStream,
    mute: bool,
}
impl Read for Duplex {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.r.read(buf)
    }
}
impl Write for Duplex {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.mute { Ok(buf.len()) } else { self.w.write(buf) }
    }
    fn flush(&mut self) -> io::Result<()> {
        if self.mute { Ok(()) } else { self.w.flush() }
    }
}

fn reject(status: u16, why: &str) -> ErrorResponse {
    eprintln!("[ipc-ws] handshake refused ({status}): {why}");
    http::Response::builder().status(status).body(Some(why.to_string())).expect("static response")
}

/// Compare without early exit (token is 32 hex chars; local-only, but cheap to do right).
fn token_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn connection(stream: TcpStream, id: u64, token: &str, opts: &Opts, host: Arc<Mutex<Host>>, shared: Arc<Shared>) -> Result<(), String> {
    let e = |what: &str, err: io::Error| format!("{what}: {err}");
    let peer = stream.peer_addr().map_err(|x| e("peer_addr", x))?;
    if !peer.ip().is_loopback() {
        return Err(format!("non-loopback peer {peer} refused"));
    }
    stream.set_nodelay(true).map_err(|x| e("nodelay", x))?;
    // a client that connects and never finishes the handshake must not park a thread forever
    stream.set_read_timeout(Some(opts.handshake)).map_err(|x| e("read timeout", x))?;
    stream.set_write_timeout(Some(opts.handshake)).map_err(|x| e("write timeout", x))?;
    let mut wcfg = WebSocketConfig::default();
    wcfg.max_message_size = Some(opts.max_message);
    wcfg.max_frame_size = Some(opts.max_message);
    let duplex = Duplex {
        r: BufReader::with_capacity(opts.read_buf, stream.try_clone().map_err(|x| e("clone", x))?),
        w: stream.try_clone().map_err(|x| e("clone", x))?,
        mute: false,
    };
    let origin_ok = opts.origin.clone();
    let mut rx = tungstenite::accept_hdr_with_config(
        duplex,
        move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
            let given = req.uri().query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("t=")));
            if !given.is_some_and(|t| token_eq(t, token)) {
                return Err(reject(403, "bad or missing token"));
            }
            if let Some(want) = &origin_ok {
                let got = req.headers().get("origin").and_then(|v| v.to_str().ok());
                if got != Some(want.as_str()) {
                    return Err(reject(403, &format!("origin {got:?} != {want:?}")));
                }
            }
            Ok(resp)
        },
        Some(wcfg),
    )
    .map_err(|x| format!("handshake: {x}"))?;
    // the page's first message can be 16 MB: no read timeout once connected (a dead peer = TCP reset/close)
    stream.set_read_timeout(None).map_err(|x| e("read timeout", x))?;
    stream.set_write_timeout(None).map_err(|x| e("write timeout", x))?;
    rx.get_mut().mute = true;
    // browsers send nothing before the 101 response, so the handshake socket holds no stray bytes; TX is a fresh socket on a dup'd fd
    let tx = WebSocket::from_raw_socket(stream.try_clone().map_err(|x| e("clone", x))?, Role::Server, Some(wcfg));
    eprintln!("[ipc-ws] conn#{id} open from {peer}");

    let in_bytes = Arc::new(AtomicU64::new(0));
    let (send, recv) = mpsc::sync_channel::<(Vec<u8>, Instant)>(opts.queue);
    let applier = {
        let (in_bytes, stream, stats_every) = (in_bytes.clone(), stream.try_clone().map_err(|x| e("clone", x))?, opts.stats_every);
        thread::Builder::new()
            .name(format!("gaia-ipc-apply#{id}"))
            .spawn(move || apply_loop(recv, tx, stream, id, &host, &shared, &in_bytes, stats_every))
            .map_err(|x| e("spawn apply", x))?
    };

    let end = loop {
        match rx.read() {
            Ok(Message::Binary(b)) => {
                in_bytes.fetch_add(b.len() as u64, Ordering::Relaxed);
                if send.send((b, Instant::now())).is_err() {
                    break "apply thread gone".to_string();
                }
            }
            Ok(Message::Close(_)) => break "peer closed".to_string(),
            Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => {}
            Ok(Message::Text(_)) => break "protocol violation: text frame (binary expected)".to_string(),
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => break "closed".to_string(),
            Err(err) => break format!("read: {err}"),
        }
    };
    drop(send); // APPLY drains what is queued, then closes
    let _ = applier.join();
    let _ = stream.shutdown(Shutdown::Both);
    eprintln!("[ipc-ws] conn#{id} closed ({end})");
    Ok(())
}

fn apply_loop(
    recv: mpsc::Receiver<(Vec<u8>, Instant)>,
    mut tx: WebSocket<TcpStream>,
    stream: TcpStream,
    id: u64,
    host: &Mutex<Host>,
    shared: &Shared,
    in_bytes: &AtomicU64,
    stats_every: Duration,
) {
    let via = format!("ws#{id}");
    let (mut win_t, mut win_msgs, mut win_applied, mut win_busy, mut win_in0) = (Instant::now(), 0u64, 0u64, Duration::ZERO, 0u64);
    for (bytes, t_in) in recv {
        let queued = t_in.elapsed();
        let t0 = Instant::now();
        let report = apply_logged(host, shared, &bytes, &via, queued)
            .unwrap_or_else(|err| format!(r#"{{"errors":[{{"op":"ipc","id":0,"msg":{:?}}}]}}"#, err).into_bytes());
        win_busy += t0.elapsed();
        win_msgs += 1;
        win_applied += bytes.len() as u64;
        if let Err(err) = tx.send(Message::Binary(report)) {
            eprintln!("[ipc-ws] conn#{id} report write failed: {err}");
            let _ = stream.shutdown(Shutdown::Both); // unblocks the RX thread
            return;
        }
        let wall = win_t.elapsed();
        if !stats_every.is_zero() && wall >= stats_every {
            let recv_now = in_bytes.load(Ordering::Relaxed);
            let mb = |b: u64| b as f64 / (1u64 << 20) as f64;
            let s = wall.as_secs_f64();
            eprintln!(
                "[ipc-ws] conn#{id} {s:.1}s: {win_msgs} msgs, recv {:.1} MB ({:.0} MB/s wall), applied {:.1} MB, apply busy {:.0} ms ({:.0} MB/s while applying)",
                mb(recv_now - win_in0),
                mb(recv_now - win_in0) / s,
                mb(win_applied),
                win_busy.as_secs_f64() * 1e3,
                mb(win_applied) / win_busy.as_secs_f64().max(1e-9)
            );
            (win_t, win_msgs, win_applied, win_busy, win_in0) = (Instant::now(), 0, 0, Duration::ZERO, recv_now);
        }
    }
    let _ = tx.close(None);
    let _ = tx.flush();
}
