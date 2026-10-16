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
}
