//! `totp_from_image` (tier 2): read a one-time-code setup QR code from an
//! image file or from the screen. The QR content is a secret: it is never
//! logged, and the pixel buffers are zeroed after decoding.

use std::path::Path;

use zeroize::{Zeroize, Zeroizing};

use crate::error::{CofferError, CofferResult, ErrorCode};

/// A QR code image is never this large.
const MAX_FILE_BYTES: u64 = 40 * 1024 * 1024;
const MAX_SIDE: u32 = 12_000;

/// Every QR code text found in a greyscale image.
fn decode_luma(width: u32, height: u32, luma: &[u8]) -> Vec<Zeroizing<String>> {
    let (w, h) = (width as usize, height as usize);
    let mut prepared = rqrr::PreparedImage::prepare_from_greyscale(w, h, |x, y| luma[y * w + x]);
    let mut out = Vec::new();
    for grid in prepared.detect_grids() {
        if let Ok((_, text)) = grid.decode() {
            out.push(Zeroizing::new(text));
        }
    }
    out
}

/// The otpauth URI among the decoded texts, or why there is none.
fn pick_uri(texts: Vec<Zeroizing<String>>, from: &str) -> CofferResult<Zeroizing<String>> {
    if texts.is_empty() {
        return Err(CofferError::new(ErrorCode::NotFound, format!("Coffer found no QR code {from}.")));
    }
    if let Some(t) = texts.iter().find(|t| t.trim().to_ascii_lowercase().starts_with("otpauth://")) {
        let uri = Zeroizing::new(t.trim().to_string());
        if coffer_core::totp::totp_parse(&uri).valid {
            return Ok(uri);
        }
        return Err(CofferError::invalid("The QR code is a one-time code setup, but Coffer cannot read its secret."));
    }
    if texts.iter().any(|t| t.trim().to_ascii_lowercase().starts_with("otpauth-migration://")) {
        return Err(CofferError::new(
            ErrorCode::UnsupportedFormat,
            "This QR code is a Google Authenticator export. Coffer reads the QR code of one account (otpauth://).",
        ));
    }
    Err(CofferError::invalid("The QR code is not a one-time code setup (otpauth://)."))
}

/// Read the QR code in an image file (PNG, JPEG or BMP).
pub fn from_file(path: &Path) -> CofferResult<Zeroizing<String>> {
    let len = std::fs::metadata(path).map_err(|_| CofferError::io("Coffer could not read that file."))?.len();
    if len > MAX_FILE_BYTES {
        return Err(CofferError::new(ErrorCode::UnsupportedFormat, "That image is too large (over 40 MB)."));
    }
    let mut reader = image::ImageReader::open(path).map_err(|_| CofferError::io("Coffer could not read that file."))?;
    reader = reader.with_guessed_format().map_err(|_| CofferError::io("Coffer could not read that file."))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    reader.limits(limits);
    let img = reader.decode().map_err(|_| CofferError::new(ErrorCode::UnsupportedFormat, "Coffer cannot open this image. Use a PNG, JPEG or BMP file."))?;
    let mut luma = img.into_luma8();
    let (w, h) = luma.dimensions();
    let texts = decode_luma(w, h, luma.as_raw());
    luma.as_mut().zeroize();
    pick_uri(texts, "in that image")
}

/// Read a QR code shown anywhere on the screens.
pub fn from_screen() -> CofferResult<Zeroizing<String>> {
    let (w, h, mut luma) = crate::win::screen::capture_luma().map_err(|e| {
        crate::log!("totp: screen capture failed: {e}");
        CofferError::io("Coffer could not read the screen.")
    })?;
    let texts = decode_luma(w, h, &luma);
    luma.zeroize();
    pick_uri(texts, "on the screen")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(name)
    }

    #[test]
    fn png_and_jpeg_fixtures_give_the_uri() {
        for name in ["totp-qr.png", "totp-qr.jpg"] {
            let uri = from_file(&fixture(name)).unwrap_or_else(|e| panic!("{name}: {}", e.message));
            assert_eq!(uri.as_str(), "otpauth://totp/Example:sam@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example", "{name}");
        }
    }

    #[test]
    fn other_qr_codes_are_refused() {
        let e = from_file(&fixture("migration-qr.png")).unwrap_err();
        assert_eq!(e.code, ErrorCode::UnsupportedFormat);
        let e = pick_uri(vec![Zeroizing::new("https://example.com".into())], "x").unwrap_err();
        assert_eq!(e.code, ErrorCode::Invalid);
        let e = pick_uri(Vec::new(), "in that image").unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound);
    }

    #[test]
    fn a_file_that_is_not_an_image() {
        let e = from_file(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml").as_path()).unwrap_err();
        assert_eq!(e.code, ErrorCode::UnsupportedFormat);
    }
}
