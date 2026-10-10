//! Wire format (little-endian everywhere). Spec lives here + README; the per-op argument lists are GENERATED (commands.gen.rs).
//!
//! stream  = command*          (split into IPC messages at any byte boundary; the decoder buffers a partial tail)
//! command = u16 op | u16 flags(0) | u32 payload_len | payload     (payload_len is a multiple of 4)
//! payload = args in render-wasm signature order (creates: the JS-allocated `u32 id` first)
//!   u32 / i32 / f32 / bool(u32 0|1)            4 bytes
//!   &[f32] &[u32] &[u8]  u32 byte_len | bytes | pad to 4      (raw typed-array bytes, zero JSON)
//!   str / json           u32 byte_len | utf8 | pad to 4       (json = small option objects only)
//!   strlist              u32 count | str*
//!   bindings             u32 count | (u32 kind 0 uniform|1 texture|2 sampler, u32 binding, u32 vertex, u32 texture, u32 len, bytes+pad)*
//! op 0 = HELLO (handled by Host, not generated): u32 api_hash | json options  -> builds the RenderCore.
//! op 0xFFFF = FREE: drops the RenderCore.
use gaia_render::MaterialBinding;
use std::borrow::Cow;

pub const OP_HELLO: u16 = 0;
pub const OP_FREE: u16 = 0xFFFF;
pub const HEADER_LEN: usize = 8;
/// framing guard: a header claiming more than this is a desynced stream (one command = one upload; 1 GiB).
pub const MAX_COMMAND_BYTES: usize = 1 << 30;
/// synthetic op handed to the sink when the framer gave up on a desynced stream.
pub const OP_CORRUPT: u16 = 0xFFFE;

#[derive(Debug, Clone, PartialEq)]
pub enum DecodeError {
    Truncated,
    Utf8,
    Json(String),
    UnknownOp(u16),
    BadKind(u32),
}
impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated => write!(f, "payload truncated"),
            Self::Utf8 => write!(f, "invalid utf-8"),
            Self::Json(e) => write!(f, "bad json: {e}"),
            Self::UnknownOp(o) => write!(f, "unknown op {o}"),
            Self::BadKind(k) => write!(f, "bad binding kind {k}"),
        }
    }
}

pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        let end = self.pos.checked_add(n).ok_or(DecodeError::Truncated)?;
        let s = self.buf.get(self.pos..end).ok_or(DecodeError::Truncated)?;
        self.pos = end;
        Ok(s)
    }
    pub fn u32(&mut self) -> Result<u32, DecodeError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    pub fn i32(&mut self) -> Result<i32, DecodeError> {
        Ok(self.u32()? as i32)
    }
    pub fn f32(&mut self) -> Result<f32, DecodeError> {
        Ok(f32::from_bits(self.u32()?))
    }
    pub fn bool(&mut self) -> Result<bool, DecodeError> {
        Ok(self.u32()? != 0)
    }
    /// length-prefixed byte run, padded to 4.
    pub fn u8s(&mut self) -> Result<&'a [u8], DecodeError> {
        let n = self.u32()? as usize;
        let s = self.take(n)?;
        self.take(pad4(n))?;
        Ok(s)
    }
    fn pod<T: bytemuck::Pod>(&mut self) -> Result<Cow<'a, [T]>, DecodeError> {
        let b = self.u8s()?;
        if b.len() % std::mem::size_of::<T>() != 0 {
            return Err(DecodeError::Truncated);
        }
        // zero-copy when the message buffer is aligned (JS keeps every array 4-aligned); copy otherwise.
        Ok(match bytemuck::try_cast_slice::<u8, T>(b) {
            Ok(s) => Cow::Borrowed(s),
            Err(_) => Cow::Owned(bytemuck::pod_collect_to_vec(b)),
        })
    }
    pub fn f32s(&mut self) -> Result<Cow<'a, [f32]>, DecodeError> {
        self.pod()
    }
    pub fn u32s(&mut self) -> Result<Cow<'a, [u32]>, DecodeError> {
        self.pod()
    }
    pub fn str(&mut self) -> Result<&'a str, DecodeError> {
        std::str::from_utf8(self.u8s()?).map_err(|_| DecodeError::Utf8)
    }
    pub fn json(&mut self) -> Result<serde_json::Value, DecodeError> {
        let s = self.str()?;
        if s.is_empty() {
            return Ok(serde_json::Value::Null);
        }
        serde_json::from_str(s).map_err(|e| DecodeError::Json(e.to_string()))
    }
    pub fn strlist(&mut self) -> Result<Vec<String>, DecodeError> {
        let n = self.u32()?;
        (0..n).map(|_| self.str().map(str::to_owned)).collect()
    }
    pub fn bindings(&mut self) -> Result<Vec<MaterialBinding>, DecodeError> {
        let n = self.u32()?;
        let mut out = Vec::with_capacity(n.min(64) as usize);
        for _ in 0..n {
            let kind = self.u32()?;
            let binding = self.u32()?;
            let vertex = self.u32()? != 0;
            let texture = self.u32()?;
            let data = self.u8s()?;
            out.push(match kind {
                0 => MaterialBinding::Uniform { binding, data: data.to_vec(), visibility_vertex: vertex },
                1 => MaterialBinding::Texture { binding, texture },
                2 => MaterialBinding::Sampler { binding },
                k => return Err(DecodeError::BadKind(k)),
            });
        }
        Ok(out)
    }
}

fn pad4(n: usize) -> usize {
    (4 - n % 4) % 4
}

/// A failed command, as reported to JS.
#[derive(Debug, Clone)]
pub struct StreamError {
    pub op: &'static str,
    pub id: u32,
    pub msg: String,
}

/// Incremental framing: feed IPC message bytes, get whole commands. A partial command buffers in `tail`.
#[derive(Default)]
pub struct Framer {
    tail: Vec<u8>,
}

impl Framer {
    pub fn pending_bytes(&self) -> usize {
        self.tail.len()
    }
    pub fn reset(&mut self) {
        self.tail.clear();
    }
    /// Calls `f(op, payload)` once per complete command, in order; returns how many.
    pub fn feed(&mut self, bytes: &[u8], mut f: impl FnMut(u16, &[u8])) -> usize {
        let mut n = 0;
        if self.tail.is_empty() {
            let used = run(bytes, &mut f, &mut n);
            if used < bytes.len() {
                self.tail.extend_from_slice(&bytes[used..]);
            }
        } else {
            // a command straddles the message boundary: join, decode from the owned buffer.
            let mut joined = std::mem::take(&mut self.tail);
            joined.extend_from_slice(bytes);
            let used = run(&joined, &mut f, &mut n);
            joined.drain(..used);
            self.tail = joined;
        }
        n
    }
}

fn run(buf: &[u8], f: &mut impl FnMut(u16, &[u8]), n: &mut usize) -> usize {
    let mut pos = 0;
    while buf.len() - pos >= HEADER_LEN {
        let op = u16::from_le_bytes([buf[pos], buf[pos + 1]]);
        let len = u32::from_le_bytes(buf[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let end = pos + HEADER_LEN + len;
        if len > MAX_COMMAND_BYTES {
            f(OP_CORRUPT, &[]); // desynced stream: drop everything buffered, report once
            return buf.len();
        }
        if end > buf.len() {
            break; // partial: wait for more bytes
        }
        f(op, &buf[pos + HEADER_LEN..end]);
        *n += 1;
        pos = end;
    }
    pos
}
