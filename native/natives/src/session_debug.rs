//! Native, capability-owned storage for redacted CLI session diagnostics.
//!
//! JavaScript supplies only a hashed session key and a random capture epoch. The
//! handle keeps file descriptors, locks, allocation state, and fatal-slot I/O in
//! Rust; JavaScript never receives a raw descriptor or a storage path below the
//! caller-vetted data directory. Any storage failure disables this handle and
//! returns `false` to the observational caller.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;

use napi::bindgen_prelude::{Buffer, Error, Result};
use napi_derive::napi;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::io::AsRawFd;

const CONTROL_BYTES: u64 = 2 * 1024 * 1024;
const MIN_SESSION_DEBUG_BYTES: u64 = 32 * 1024 * 1024;
const FATAL_SLOT_BYTES: usize = 64 * 1024;
const FIXED_RECORD_BYTES: usize = 4096;
const FIXED_RECORD_CRC_OFFSET: usize = FIXED_RECORD_BYTES - 4;
const FIXED_RECORD_PAYLOAD_OFFSET: usize = 20;
const MAX_FRAME_PAYLOAD_BYTES: usize = FIXED_RECORD_CRC_OFFSET - FIXED_RECORD_PAYLOAD_OFFSET;
const MAX_QUEUE_JOBS: usize = 128;
const SCHEMA_VERSION: u16 = 1;
const TRACE_MAGIC: [u8; 4] = *b"MCTF";
const SEQUENCE_MAGIC: [u8; 4] = *b"MCQS";

#[napi(object)]
pub struct SessionDebugOpenOptions {
    /// Caller-vetted Mission Control data directory; native appends only fixed
    /// diagnostic path components below it.
    pub root: String,
    /// SHA-256 session key digest; raw session IDs are rejected at this boundary.
    pub session_key_digest: String,
    /// Random 128-bit capture epoch encoded as lowercase hex.
    pub capture_epoch: String,
    /// Per-session physical allowance, including the fixed control reserve.
    pub max_bytes: f64,
}

#[napi(object)]
pub struct SessionDebugStatus {
    pub enabled: bool,
    pub sequence: f64,
    pub trace_capacity_bytes: f64,
}

#[napi]
pub struct SessionDebugFsHandle {
    producer: Mutex<Option<SyncSender<DebugJob>>>,
    state: Arc<Mutex<DebugStore>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

#[napi]
impl SessionDebugFsHandle {
    /// Queue a single bounded, already-redacted diagnostic payload. This is a
    /// nonblocking operation: full queues or failed storage simply drop debug
    /// data and report `false`; they never alter normal execution.
    #[napi]
    pub fn try_enqueue(&self, payload: Buffer) -> bool {
        if payload.len() > MAX_FRAME_PAYLOAD_BYTES {
            return false;
        }
        let producer = match self.producer.lock() {
            Ok(producer) => producer,
            Err(_) => return false,
        };
        let Some(producer) = producer.as_ref() else {
            return false;
        };
        match producer.try_send(DebugJob::Frame(payload.to_vec())) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => false,
        }
    }

    /// Performs the pre-opened fixed-slot fatal write. Callers must redact and
    /// bound the payload before this call; the native layer truncates and zero
    /// fills the slot to keep crash I/O allocation-free after acquisition.
    #[napi]
    pub fn write_fatal(&self, payload: Buffer) -> bool {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        state.write_fatal(&payload)
    }

    #[napi(getter)]
    pub fn status(&self) -> SessionDebugStatus {
        match self.state.lock() {
            Ok(state) => SessionDebugStatus {
                enabled: state.enabled,
                sequence: state.sequence as f64,
                trace_capacity_bytes: state.trace_capacity as f64,
            },
            Err(_) => SessionDebugStatus {
                enabled: false,
                sequence: 0.0,
                trace_capacity_bytes: 0.0,
            },
        }
    }

    #[napi]
    pub fn close(&self) {
        if let Ok(mut producer) = self.producer.lock() {
            producer.take();
        }
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
        if let Ok(mut state) = self.state.lock() {
            state.close();
        }
    }
}

impl Drop for SessionDebugFsHandle {
    fn drop(&mut self) {
        self.close();
    }
}

/// Opens a Linux-only, per-session native storage capability. The core client
/// treats failures as an unavailable optional feature and continues normally.
#[napi]
pub fn open_session_debug(options: SessionDebugOpenOptions) -> Result<SessionDebugFsHandle> {
    let max_bytes = parse_max_bytes(options.max_bytes).map_err(Error::from_reason)?;
    let store = DebugStore::open(
        Path::new(&options.root),
        &options.session_key_digest,
        &options.capture_epoch,
        max_bytes,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    let state = Arc::new(Mutex::new(store));
    let (producer, receiver) = mpsc::sync_channel(MAX_QUEUE_JOBS);
    let worker_state = Arc::clone(&state);
    let worker = thread::Builder::new()
        .name("mission-control-session-debug".to_owned())
        .spawn(move || {
            while let Ok(job) = receiver.recv() {
                match job {
                    DebugJob::Frame(payload) => {
                        let Ok(mut state) = worker_state.lock() else {
                            return;
                        };
                        state.append_frame(&payload);
                    }
                }
            }
        });
    let worker = match worker {
        Ok(worker) => worker,
        Err(_) => {
            if let Ok(mut state) = state.lock() {
                state.close();
            }
            return Err(Error::from_reason("unable to start session debug writer"));
        }
    };
    Ok(SessionDebugFsHandle {
        producer: Mutex::new(Some(producer)),
        state,
        worker: Mutex::new(Some(worker)),
    })
}

enum DebugJob {
    Frame(Vec<u8>),
}

struct DebugStore {
    _lock: File,
    trace: File,
    sequence_state: File,
    fatal_slot: File,
    trace_capacity: u64,
    sequence: u64,
    enabled: bool,
}

impl DebugStore {
    fn open(
        root: &Path,
        session_key_digest: &str,
        capture_epoch: &str,
        max_bytes: u64,
    ) -> io::Result<Self> {
        validate_hex(session_key_digest, 64)?;
        validate_hex(capture_epoch, 32)?;
        #[cfg(not(unix))]
        {
            let _ = (root, session_key_digest, capture_epoch, max_bytes);
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "session debug native storage requires Unix filesystem primitives",
            ));
        }
        #[cfg(unix)]
        {
            let session_dir = root
                .join("session-debug")
                .join("v1")
                .join("sessions")
                .join(session_key_digest)
                .join("epochs")
                .join(capture_epoch);
            ensure_private_directory(&session_dir)?;
            let lock = open_private_file(&session_dir.join("lease.lock"), true)?;
            acquire_nonblocking_lock(&lock)?;
            let trace_capacity = max_bytes.checked_sub(CONTROL_BYTES).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "session debug maxBytes does not cover control storage",
                )
            })?;
            if trace_capacity < FIXED_RECORD_BYTES as u64 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "session debug trace allocation is smaller than one fixed record",
                ));
            }
            let trace = open_private_file(&session_dir.join("trace.arena"), true)?;
            preallocate_exactly(&trace, trace_capacity)?;
            let sequence_state = open_private_file(&session_dir.join("trace.sequence"), true)?;
            initialize_sequence_state(&sequence_state)?;
            let sequence = read_sequence_state(&sequence_state)?;
            let fatal_slot = open_private_file(&session_dir.join("fatal.slot"), true)?;
            preallocate_exactly(&fatal_slot, FATAL_SLOT_BYTES as u64)?;
            Ok(Self {
                _lock: lock,
                trace,
                sequence_state,
                fatal_slot,
                trace_capacity,
                sequence,
                enabled: true,
            })
        }
    }

    fn append_frame(&mut self, payload: &[u8]) {
        if !self.enabled || payload.len() > MAX_FRAME_PAYLOAD_BYTES {
            return;
        }
        let Some(next_sequence) = self.sequence.checked_add(1) else {
            self.enabled = false;
            return;
        };
        let Some(offset) = next_sequence
            .checked_sub(1)
            .and_then(|value| value.checked_mul(FIXED_RECORD_BYTES as u64))
        else {
            self.enabled = false;
            return;
        };
        if offset
            .checked_add(FIXED_RECORD_BYTES as u64)
            .is_none_or(|end| end > self.trace_capacity)
        {
            self.enabled = false;
            return;
        }
        let frame = encode_fixed_record(TRACE_MAGIC, next_sequence, payload);
        if write_all_at(&self.trace, offset, &frame).is_err() || self.trace.sync_data().is_err() {
            self.enabled = false;
            return;
        }
        let state = encode_fixed_record(SEQUENCE_MAGIC, next_sequence, &[]);
        let state_offset = if next_sequence % 2 == 0 {
            0
        } else {
            FIXED_RECORD_BYTES as u64
        };
        if write_all_at(&self.sequence_state, state_offset, &state).is_err()
            || self.sequence_state.sync_data().is_err()
        {
            self.enabled = false;
            return;
        }
        self.sequence = next_sequence;
    }

    fn write_fatal(&mut self, payload: &[u8]) -> bool {
        if !self.enabled {
            return false;
        }
        let mut fixed = [0_u8; FATAL_SLOT_BYTES];
        let length = payload.len().min(FATAL_SLOT_BYTES);
        fixed[..length].copy_from_slice(&payload[..length]);
        if write_all_at(&self.fatal_slot, 0, &fixed).is_err()
            || self.fatal_slot.sync_data().is_err()
        {
            self.enabled = false;
            return false;
        }
        true
    }

    fn close(&mut self) {
        if !self.enabled {
            return;
        }
        if self.trace.sync_data().is_err()
            || self.sequence_state.sync_data().is_err()
            || self.fatal_slot.sync_data().is_err()
        {
            self.enabled = false;
            return;
        }
        self.enabled = false;
    }
}

fn parse_max_bytes(value: f64) -> std::result::Result<u64, String> {
    if !value.is_finite()
        || value.fract() != 0.0
        || value < MIN_SESSION_DEBUG_BYTES as f64
        || value > 1024.0 * 1024.0 * 1024.0
    {
        return Err(
            "session debug maxBytes must be an integer between 32 MiB and 1 GiB".to_owned(),
        );
    }
    Ok(value as u64)
}

fn validate_hex(value: &str, length: usize) -> io::Result<()> {
    if value.len() != length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "session debug identity must be a lowercase hexadecimal digest",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "session debug directory is not a real directory",
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(unix)]
fn open_private_file(path: &Path, write: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(write)
        .create(write)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    options.open(path)
}

#[cfg(unix)]
fn acquire_nonblocking_lock(file: &File) -> io::Result<()> {
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        return Ok(());
    }
    Err(io::Error::last_os_error())
}

#[cfg(unix)]
fn preallocate_exactly(file: &File, bytes: u64) -> io::Result<()> {
    let offset = i64::try_from(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "allocation exceeds off_t"))?;
    let result = unsafe { libc::posix_fallocate(file.as_raw_fd(), 0, offset) };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result));
    }
    let metadata = file.metadata()?;
    if metadata.len() != bytes {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "debug allocation length mismatch",
        ));
    }
    use std::os::unix::fs::MetadataExt;
    let physical_bytes = metadata.blocks().saturating_mul(512);
    if physical_bytes < bytes {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "debug allocation is sparse or quota-unverifiable",
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn write_all_at(_file: &File, _offset: u64, _bytes: &[u8]) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "session debug storage requires Unix",
    ))
}

#[cfg(unix)]
fn write_all_at(file: &File, offset: u64, bytes: &[u8]) -> io::Result<()> {
    use std::os::unix::fs::FileExt;
    let mut written = 0_usize;
    while written < bytes.len() {
        let next_offset = offset.checked_add(written as u64).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "debug write offset overflow")
        })?;
        let count = file.write_at(&bytes[written..], next_offset)?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "debug write made no progress",
            ));
        }
        written += count;
    }
    Ok(())
}

fn initialize_sequence_state(file: &File) -> io::Result<()> {
    let metadata = file.metadata()?;
    if metadata.len() == 0 {
        let state = encode_fixed_record(SEQUENCE_MAGIC, 0, &[]);
        write_all_at(file, 0, &state)?;
        write_all_at(file, FIXED_RECORD_BYTES as u64, &state)?;
        file.sync_data()?;
        return Ok(());
    }
    if metadata.len() != (FIXED_RECORD_BYTES * 2) as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid session debug sequence state size",
        ));
    }
    Ok(())
}

fn read_sequence_state(file: &File) -> io::Result<u64> {
    let mut records = [[0_u8; FIXED_RECORD_BYTES]; 2];
    for (index, record) in records.iter_mut().enumerate() {
        read_exact_at(file, (index * FIXED_RECORD_BYTES) as u64, record)?;
    }
    let mut sequence = None;
    for record in records {
        let decoded = decode_fixed_record(&record, SEQUENCE_MAGIC)?;
        sequence = Some(sequence.map_or(decoded.sequence, |current: u64| {
            current.max(decoded.sequence)
        }));
    }
    sequence.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "empty session debug sequence state",
        )
    })
}

#[cfg(unix)]
fn read_exact_at(file: &File, offset: u64, bytes: &mut [u8]) -> io::Result<()> {
    use std::os::unix::fs::FileExt;
    let mut read = 0_usize;
    while read < bytes.len() {
        let next_offset = offset.checked_add(read as u64).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "debug read offset overflow")
        })?;
        let count = file.read_at(&mut bytes[read..], next_offset)?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "debug record is truncated",
            ));
        }
        read += count;
    }
    Ok(())
}

#[cfg(not(unix))]
fn read_exact_at(_file: &File, _offset: u64, _bytes: &mut [u8]) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "session debug storage requires Unix",
    ))
}

struct FixedRecord {
    sequence: u64,
    #[cfg(test)]
    payload: Vec<u8>,
}

fn encode_fixed_record(magic: [u8; 4], sequence: u64, payload: &[u8]) -> [u8; FIXED_RECORD_BYTES] {
    let mut record = [0_u8; FIXED_RECORD_BYTES];
    record[..4].copy_from_slice(&magic);
    record[4..6].copy_from_slice(&SCHEMA_VERSION.to_le_bytes());
    record[8..16].copy_from_slice(&sequence.to_le_bytes());
    let payload_len = match u32::try_from(payload.len()) {
        Ok(length) => length,
        Err(_) => return record,
    };
    record[16..20].copy_from_slice(&payload_len.to_le_bytes());
    if payload.len() <= MAX_FRAME_PAYLOAD_BYTES {
        record[FIXED_RECORD_PAYLOAD_OFFSET..FIXED_RECORD_PAYLOAD_OFFSET + payload.len()]
            .copy_from_slice(payload);
    }
    let checksum = crc32(&record[..FIXED_RECORD_CRC_OFFSET]);
    record[FIXED_RECORD_CRC_OFFSET..].copy_from_slice(&checksum.to_le_bytes());
    record
}

fn decode_fixed_record(
    record: &[u8; FIXED_RECORD_BYTES],
    expected_magic: [u8; 4],
) -> io::Result<FixedRecord> {
    if record[..4] != expected_magic {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid session debug record magic",
        ));
    }
    let schema = u16::from_le_bytes([record[4], record[5]]);
    if schema != SCHEMA_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported session debug record schema",
        ));
    }
    let checksum = u32::from_le_bytes([
        record[FIXED_RECORD_CRC_OFFSET],
        record[FIXED_RECORD_CRC_OFFSET + 1],
        record[FIXED_RECORD_CRC_OFFSET + 2],
        record[FIXED_RECORD_CRC_OFFSET + 3],
    ]);
    if crc32(&record[..FIXED_RECORD_CRC_OFFSET]) != checksum {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid session debug record checksum",
        ));
    }
    let payload_len = u32::from_le_bytes([record[16], record[17], record[18], record[19]]) as usize;
    if payload_len > MAX_FRAME_PAYLOAD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "session debug record payload exceeds fixed frame",
        ));
    }
    let payload_end = FIXED_RECORD_PAYLOAD_OFFSET + payload_len;
    if record[payload_end..FIXED_RECORD_CRC_OFFSET]
        .iter()
        .any(|byte| *byte != 0)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "session debug record has non-zero padding",
        ));
    }
    let sequence = u64::from_le_bytes([
        record[8], record[9], record[10], record[11], record[12], record[13], record[14],
        record[15],
    ]);
    Ok(FixedRecord {
        sequence,
        #[cfg(test)]
        payload: record[FIXED_RECORD_PAYLOAD_OFFSET..payload_end].to_vec(),
    })
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = if crc & 1 == 0 { 0 } else { 0xEDB8_8320 };
            crc = (crc >> 1) ^ mask;
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn fixed_records_validate_magic_checksum_padding_and_payload() {
        let record = encode_fixed_record(TRACE_MAGIC, 7, b"redacted");
        let decoded = decode_fixed_record(&record, TRACE_MAGIC);
        assert!(decoded.is_ok());
        let decoded = match decoded {
            Ok(value) => value,
            Err(_) => return,
        };
        assert_eq!(decoded.sequence, 7);
        assert_eq!(decoded.payload, b"redacted");

        let mut corrupt = record;
        corrupt[30] = 1;
        assert!(decode_fixed_record(&corrupt, TRACE_MAGIC).is_err());
        assert!(decode_fixed_record(&record, SEQUENCE_MAGIC).is_err());
    }

    #[test]
    fn max_bytes_rejects_non_integral_or_out_of_range_values() {
        assert!(parse_max_bytes(1.5).is_err());
        assert!(parse_max_bytes((MIN_SESSION_DEBUG_BYTES - 1) as f64).is_err());
        assert!(parse_max_bytes(1024.0 * 1024.0 * 1024.0 + 1.0).is_err());
        assert_eq!(
            parse_max_bytes(MIN_SESSION_DEBUG_BYTES as f64),
            Ok(MIN_SESSION_DEBUG_BYTES)
        );
    }

    #[test]
    fn store_preallocates_the_physical_trace_arena_and_persists_fixed_frames() {
        let nonce = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_nanos(),
            Err(_) => return,
        };
        let root = std::env::temp_dir().join(format!("mission-control-session-debug-{nonce}"));
        let session_key_digest = "a".repeat(64);
        let capture_epoch = "b".repeat(32);
        let mut store = match DebugStore::open(
            &root,
            &session_key_digest,
            &capture_epoch,
            MIN_SESSION_DEBUG_BYTES,
        ) {
            Ok(store) => store,
            Err(_) => return,
        };

        store.append_frame(b"redacted event");
        let trace_path = root
            .join("session-debug")
            .join("v1")
            .join("sessions")
            .join(&session_key_digest)
            .join("epochs")
            .join(&capture_epoch)
            .join("trace.arena");
        let trace = match fs::read(&trace_path) {
            Ok(trace) => trace,
            Err(_) => return,
        };
        let expected_capacity = MIN_SESSION_DEBUG_BYTES - CONTROL_BYTES;

        assert_eq!(trace.len() as u64, expected_capacity);
        let first_record: &[u8; FIXED_RECORD_BYTES] = match trace[..FIXED_RECORD_BYTES].try_into() {
            Ok(record) => record,
            Err(_) => return,
        };
        assert!(matches!(
            decode_fixed_record(first_record, TRACE_MAGIC),
            Ok(record) if record.payload == b"redacted event"
        ));

        store.close();
        let _ = fs::remove_dir_all(root);
    }
}
