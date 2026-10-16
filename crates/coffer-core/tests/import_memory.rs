//! Review item 4: import memory stays bounded. A counting allocator
//! measures the peak heap of `parse_import` on the reviewer's inputs
//! (scaled so the dev build stays quick). Own test binary: the allocator
//! counts nothing else, and the cases run one after another.

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};

use coffer_core::import::{ImportRequest, parse_import};

struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: forwards to the system allocator and only counts sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        // SAFETY: same contract as the caller's.
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            let c = CUR.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(c, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        // SAFETY: same contract as the caller's.
        unsafe { System.dealloc(p, l) };
        CUR.fetch_sub(l.size(), Ordering::Relaxed);
    }
}

#[global_allocator]
static A: Counting = Counting;

const MIB: usize = 1 << 20;

fn zip_of(entries: &[(&str, usize)]) -> Vec<u8> {
    let mut cur = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut cur);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).compression_level(Some(1));
        let chunk = vec![b'a'; MIB];
        for (name, mib) in entries {
            z.start_file(*name, opts).unwrap();
            for _ in 0..*mib {
                z.write_all(&chunk).unwrap();
            }
        }
        z.finish().unwrap();
    }
    cur.into_inner()
}

/// Peak extra heap (MiB) of an import, and its error code.
fn measure(name: &str, bytes: &[u8]) -> (usize, Option<&'static str>) {
    let base = CUR.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let r = parse_import(&ImportRequest { file_name: name, bytes, password: None, secret_key: None }, None);
    let peak = PEAK.load(Ordering::Relaxed).saturating_sub(base);
    (peak / MIB, r.err().map(|e| e.code()))
}

#[test]
fn import_memory_is_bounded() {
    // Entries no importer reads are never unpacked (before: every entry,
    // 4 x 64 MiB in a 255 KiB file = 576 MiB peak).
    let z = zip_of(&[("f0.txt", 24), ("f1.txt", 24)]);
    let (peak, err) = measure("x.zip", &z);
    assert_eq!(err, Some("unsupportedFormat"));
    eprintln!("zip, 2 x 24 MiB unread entries: peak {peak} MiB");
    assert!(peak < 8, "zip of unread entries: peak {peak} MiB");

    // CSV entries over the 64 MiB total stop the read (before: no total cap).
    let z = zip_of(&[("a.csv", 33), ("b.csv", 33)]);
    let (peak, err) = measure("x.zip", &z);
    assert_eq!(err, Some("unsupportedFormat"));
    eprintln!("zip, 2 x 33 MiB CSV entries: peak {peak} MiB");
    assert!(peak < 80, "zip over the total cap: peak {peak} MiB");

    // The reviewer's 1PUX: a small zip whose export.data is over 16 MiB
    // of `[],` (before: parsed into a JSON tree, about 25x its size).
    let mut data = Vec::with_capacity(17 * MIB + 8);
    data.push(b'[');
    while data.len() < 17 * MIB {
        data.extend_from_slice(b"[],");
    }
    data.extend_from_slice(b"[]]");
    let z = {
        let mut cur = std::io::Cursor::new(Vec::new());
        let mut w = zip::ZipWriter::new(&mut cur);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).compression_level(Some(1));
        w.start_file("export.data", opts).unwrap();
        w.write_all(&data).unwrap();
        w.finish().unwrap();
        drop(data);
        cur.into_inner()
    };
    let (peak, err) = measure("x.1pux", &z);
    eprintln!("1PUX, export.data 17 MiB of `[],` in a {} KiB zip: peak {peak} MiB", z.len() / 1024);
    assert_eq!(err, Some("unsupportedFormat"));
    assert!(peak < 24, "1PUX with a large export.data: peak {peak} MiB");

    // The same shape as a plain JSON file: refused before parsing.
    let mut json = Vec::with_capacity(17 * MIB + 16);
    json.extend_from_slice(b"{\"items\":[");
    while json.len() < 17 * MIB {
        json.extend_from_slice(b"[],");
    }
    json.extend_from_slice(b"[]]}");
    let (peak, err) = measure("x.json", &json);
    eprintln!("JSON, 17 MiB of `[],`: peak {peak} MiB");
    assert_eq!(err, Some("invalid"));
    assert!(peak < 2, "large JSON: peak {peak} MiB");

    // The reviewer's CSV: 200 columns with 1000-character names, 1000
    // empty rows (394 KiB; before: 203 MiB peak).
    let mut s = String::from("type,name,login_uri,login_password");
    for c in 0..200 {
        s.push_str(&format!(",{c:01000}"));
    }
    s.push('\n');
    let row = ",".repeat(203);
    for _ in 0..1000 {
        s.push_str(&row);
        s.push('\n');
    }
    let (peak, _) = measure("x.csv", s.as_bytes());
    eprintln!("CSV, 200 x 1000-char headers, 1000 rows: peak {peak} MiB");
    assert!(peak < 16, "wide CSV: peak {peak} MiB");
}
