//! Byte encodings of SPEC 3.4: every AAD and MAC input is a sequence of
//! fields, each `u32 big-endian length || bytes`; the first field is a label.

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::crypto::KdfParams;

/// Record kind byte: 1 = item.
pub const KIND_ITEM: u8 = 1;
/// Record kind byte: 2 = meta.
pub const KIND_META: u8 = 2;

/// Builder of a length-prefixed field sequence.
#[derive(Default)]
pub struct Fields(Vec<u8>);

impl Fields {
    /// Starts a sequence with its label field.
    pub fn new(label: &str) -> Self {
        Fields(Vec::new()).bytes(label.as_bytes())
    }

    /// Appends one field.
    pub fn bytes(mut self, b: &[u8]) -> Self {
        let len = u32::try_from(b.len()).expect("field longer than u32::MAX");
        self.0.extend_from_slice(&len.to_be_bytes());
        self.0.extend_from_slice(b);
        self
    }

    /// Appends a u32 big-endian field (length 4).
    pub fn u32(self, v: u32) -> Self {
        self.bytes(&v.to_be_bytes())
    }

    /// Appends a u64 big-endian field (length 8).
    pub fn u64(self, v: u64) -> Self {
        self.bytes(&v.to_be_bytes())
    }

    /// Appends a 1-byte field.
    pub fn u8(self, v: u8) -> Self {
        self.bytes(&[v])
    }

    /// Appends the 16 raw bytes of a UUID.
    pub fn id(self, id: &Uuid) -> Self {
        self.bytes(id.as_bytes())
    }

    /// The encoded bytes.
    pub fn finish(self) -> Vec<u8> {
        self.0
    }
}

/// `header_aad` = fields: "coffer/v1/header", vault_id, "argon2id", m_kib, t, p, salt, key_id.
pub fn header_aad(vault_id: &Uuid, kdf: &KdfParams, salt: &[u8], key_id: &str) -> Vec<u8> {
    Fields::new("coffer/v1/header")
        .id(vault_id)
        .bytes(b"argon2id")
        .u32(kdf.m_kib)
        .u32(kdf.t)
        .u32(kdf.p)
        .bytes(salt)
        .bytes(key_id.as_bytes())
        .finish()
}

/// Record AAD = fields: "coffer/v1/record", vault_id, id, kind, rev.
pub fn record_aad(vault_id: &Uuid, id: &Uuid, kind: u8, rev: u64) -> Vec<u8> {
    Fields::new("coffer/v1/record")
        .id(vault_id)
        .id(id)
        .u8(kind)
        .u64(rev)
        .finish()
}

/// One record as the manifest sees it.
pub struct ManifestEntry<'a> {
    /// Record id.
    pub id: Uuid,
    /// Kind byte.
    pub kind: u8,
    /// Revision.
    pub rev: u64,
    /// The 24-byte nonce.
    pub nonce: &'a [u8],
    /// The ciphertext with its tag.
    pub ct: &'a [u8],
}

/// Manifest input = fields: "coffer/v1/manifest", vault_id, generation, record
/// count, then for each record sorted by id bytes: id, kind, rev,
/// SHA-256(nonce || ct).
pub fn manifest_input(vault_id: &Uuid, generation: u64, records: &[ManifestEntry<'_>]) -> Vec<u8> {
    let mut sorted: Vec<&ManifestEntry<'_>> = records.iter().collect();
    sorted.sort_by(|a, b| a.id.as_bytes().cmp(b.id.as_bytes()));
    let mut f = Fields::new("coffer/v1/manifest")
        .id(vault_id)
        .u64(generation)
        .u64(records.len() as u64);
    for r in sorted {
        let mut h = Sha256::new();
        h.update(r.nonce);
        h.update(r.ct);
        let digest = h.finalize();
        f = f.id(&r.id).u8(r.kind).u64(r.rev).bytes(&digest);
    }
    f.finish()
}

/// Attachment AAD (tier 3) = fields: "coffer/v1/attachment", vault_id, item_id, attachment_id.
pub fn attachment_aad(vault_id: &Uuid, item_id: &Uuid, attachment_id: &Uuid) -> Vec<u8> {
    Fields::new("coffer/v1/attachment")
        .id(vault_id)
        .id(item_id)
        .id(attachment_id)
        .finish()
}

/// Pads `buf` with spaces to a multiple of 256 bytes (SPEC 3.4).
pub fn pad_256(buf: &mut Vec<u8>) {
    let rem = buf.len() % 256;
    if rem != 0 || buf.is_empty() {
        let add = 256 - rem;
        buf.resize(buf.len() + add, b' ');
    }
}

/// The length after [`pad_256`].
pub(crate) fn padded_256_len(len: usize) -> usize {
    if len == 0 { 256 } else { len.div_ceil(256) * 256 }
}

/// A plaintext byte buffer that never frees an unwiped copy: it grows by
/// copying into a new, larger buffer and zeroing the old one (a plain
/// `Vec` reallocates and frees the old block as it is). Zeroed on drop.
pub(crate) struct SecretBuf(zeroize::Zeroizing<Vec<u8>>);

impl SecretBuf {
    /// An empty buffer with room for `cap` bytes.
    pub(crate) fn with_capacity(cap: usize) -> Self {
        SecretBuf(zeroize::Zeroizing::new(Vec::with_capacity(cap)))
    }

    fn reserve_wiped(&mut self, extra: usize) {
        let need = self.0.len() + extra;
        if need <= self.0.capacity() {
            return;
        }
        let mut next = zeroize::Zeroizing::new(Vec::with_capacity(need.max(self.0.capacity() * 2).max(256)));
        next.extend_from_slice(&self.0);
        self.0 = next; // the old buffer is zeroed as it drops
    }

    /// Pads with spaces to a multiple of 256 (as [`pad_256`]), growing
    /// through the wiping path.
    pub(crate) fn pad_256(&mut self) {
        let len = self.0.len();
        let add = padded_256_len(len) - len;
        self.reserve_wiped(add);
        self.0.resize(len + add, b' ');
    }

    /// The bytes.
    pub(crate) fn as_slice(&self) -> &[u8] {
        &self.0
    }

    /// The buffer.
    pub(crate) fn into_inner(self) -> zeroize::Zeroizing<Vec<u8>> {
        self.0
    }
}

impl std::io::Write for SecretBuf {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.reserve_wiped(buf.len());
        self.0.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// JSON of a value written into a [`SecretBuf`].
pub(crate) fn json_secret<T: serde::Serialize + ?Sized>(value: &T, pretty: bool) -> SecretBuf {
    let mut buf = SecretBuf::with_capacity(4096);
    let r = if pretty { serde_json::to_writer_pretty(&mut buf, value) } else { serde_json::to_writer(&mut buf, value) };
    r.expect("JSON serialisation into memory cannot fail");
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_are_length_prefixed_big_endian() {
        let b = Fields::new("ab").u8(7).u32(1).u64(2).finish();
        assert_eq!(
            b,
            vec![
                0, 0, 0, 2, b'a', b'b', //
                0, 0, 0, 1, 7, //
                0, 0, 0, 4, 0, 0, 0, 1, //
                0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 2
            ]
        );
    }

    #[test]
    fn record_aad_layout() {
        let v = Uuid::from_bytes([1; 16]);
        let i = Uuid::from_bytes([2; 16]);
        let aad = record_aad(&v, &i, KIND_ITEM, 7);
        let mut want = Vec::new();
        want.extend_from_slice(&16u32.to_be_bytes());
        want.extend_from_slice(b"coffer/v1/record");
        want.extend_from_slice(&16u32.to_be_bytes());
        want.extend_from_slice(&[1; 16]);
        want.extend_from_slice(&16u32.to_be_bytes());
        want.extend_from_slice(&[2; 16]);
        want.extend_from_slice(&1u32.to_be_bytes());
        want.push(1);
        want.extend_from_slice(&8u32.to_be_bytes());
        want.extend_from_slice(&7u64.to_be_bytes());
        assert_eq!(aad, want);
    }

    #[test]
    fn manifest_sorts_by_id_bytes() {
        let v = Uuid::from_bytes([9; 16]);
        let a = ManifestEntry { id: Uuid::from_bytes([1; 16]), kind: 1, rev: 1, nonce: b"n1", ct: b"c1" };
        let b = ManifestEntry { id: Uuid::from_bytes([2; 16]), kind: 2, rev: 3, nonce: b"n2", ct: b"c2" };
        let b2 = ManifestEntry { id: Uuid::from_bytes([2; 16]), kind: 2, rev: 3, nonce: b"n2", ct: b"c2" };
        let a2 = ManifestEntry { id: Uuid::from_bytes([1; 16]), kind: 1, rev: 1, nonce: b"n1", ct: b"c1" };
        assert_eq!(manifest_input(&v, 5, &[a, b]), manifest_input(&v, 5, &[b2, a2]));
    }

    #[test]
    fn padding_to_256() {
        let mut b = vec![b'x'; 10];
        pad_256(&mut b);
        assert_eq!(b.len(), 256);
        let mut c = vec![b'x'; 256];
        pad_256(&mut c);
        assert_eq!(c.len(), 256);
        let mut d = vec![b'x'; 257];
        pad_256(&mut d);
        assert_eq!(d.len(), 512);
        assert!(d[257..].iter().all(|&x| x == b' '));
    }
    /// Review item 7: plaintext buffers grow and pad without freeing an
    /// unwiped copy; the bytes equal what `pad_256` makes.
    #[test]
    fn secret_buf_grows_and_pads_like_pad_256() {
        use std::io::Write;
        let data: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        let mut b = SecretBuf::with_capacity(1);
        for c in data.chunks(7) {
            b.write_all(c).unwrap();
        }
        assert_eq!(b.as_slice(), &data[..]);
        b.pad_256();
        let mut v = data.clone();
        pad_256(&mut v);
        assert_eq!(b.as_slice(), &v[..]);
        // With the final length reserved first, padding does not reallocate.
        let mut r = SecretBuf::with_capacity(padded_256_len(300));
        r.write_all(&[1u8; 300]).unwrap();
        let ptr = r.as_slice().as_ptr();
        r.pad_256();
        assert_eq!(r.as_slice().as_ptr(), ptr);
        assert_eq!(r.as_slice().len(), 512);
        for (n, want) in [(0, 256), (1, 256), (256, 256), (257, 512)] {
            assert_eq!(padded_256_len(n), want);
            let mut e = SecretBuf::with_capacity(0);
            e.write_all(&vec![0u8; n]).unwrap();
            e.pad_256();
            assert_eq!(e.as_slice().len(), want);
        }
        assert_eq!(&*json_secret(&serde_json::json!({"a": 1}), false).into_inner(), br#"{"a":1}"#);
    }
}
