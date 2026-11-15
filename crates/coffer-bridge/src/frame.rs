//! Native messaging framing: a 4-byte little-endian length, then the message.
//! The same framing runs on the pipe between coffer-bridge.exe and Coffer.

use std::io::{self, Read, Write};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Debug)]
pub enum FrameError {
    /// The stream ended before the first byte of a frame (a clean close).
    Closed,
    /// The length prefix says more than the limit. The bytes are still in the
    /// stream: `skip` them, or close the stream.
    TooLarge(usize),
    /// A read or write failed, or the stream ended inside a frame.
    Io(io::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Closed => write!(f, "the stream closed"),
            FrameError::TooLarge(n) => write!(f, "a message of {n} bytes is over the limit"),
            FrameError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl From<io::Error> for FrameError {
    fn from(e: io::Error) -> Self {
        FrameError::Io(e)
    }
}

/// The 4-byte prefix and the message, or `TooLarge` over `max`.
pub fn encode(message: &[u8], max: usize) -> Result<Vec<u8>, FrameError> {
    if message.len() > max {
        return Err(FrameError::TooLarge(message.len()));
    }
    let mut out = Vec::with_capacity(4 + message.len());
    out.extend_from_slice(&(message.len() as u32).to_le_bytes());
    out.extend_from_slice(message);
    Ok(out)
}

/// Fill `buf`. `Ok(false)` when the stream ended before the first byte.
fn read_full<R: Read>(r: &mut R, buf: &mut [u8]) -> Result<bool, FrameError> {
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..]) {
            Ok(0) if got == 0 => return Ok(false),
            Ok(0) => return Err(FrameError::Io(io::ErrorKind::UnexpectedEof.into())),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(true)
}

/// Read one frame of at most `max` bytes.
pub fn read<R: Read>(r: &mut R, max: usize) -> Result<Vec<u8>, FrameError> {
    let mut len = [0u8; 4];
    if !read_full(r, &mut len)? {
        return Err(FrameError::Closed);
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > max {
        return Err(FrameError::TooLarge(len));
    }
    let mut buf = vec![0u8; len];
    if len > 0 && !read_full(r, &mut buf)? {
        return Err(FrameError::Io(io::ErrorKind::UnexpectedEof.into()));
    }
    Ok(buf)
}

/// Read and drop `len` bytes (the body of a frame that was too large).
pub fn skip<R: Read>(r: &mut R, len: usize) -> Result<(), FrameError> {
    let copied = io::copy(&mut r.take(len as u64), &mut io::sink())?;
    if copied as usize != len {
        return Err(FrameError::Io(io::ErrorKind::UnexpectedEof.into()));
    }
    Ok(())
}

/// Write one frame and flush.
pub fn write<W: Write>(w: &mut W, message: &[u8], max: usize) -> Result<(), FrameError> {
    w.write_all(&encode(message, max)?)?;
    w.flush()?;
    Ok(())
}

/// `read` for an async stream (the pipe).
pub async fn read_async<R: AsyncRead + Unpin>(r: &mut R, max: usize) -> Result<Vec<u8>, FrameError> {
    let mut len = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        let n = r.read(&mut len[got..]).await?;
        if n == 0 {
            return Err(if got == 0 { FrameError::Closed } else { FrameError::Io(io::ErrorKind::UnexpectedEof.into()) });
        }
        got += n;
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > max {
        return Err(FrameError::TooLarge(len));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    Ok(buf)
}

/// `write` for an async stream (the pipe).
pub async fn write_async<W: AsyncWrite + Unpin>(w: &mut W, message: &[u8], max: usize) -> Result<(), FrameError> {
    w.write_all(&encode(message, max)?).await?;
    w.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MAX_MESSAGE;

    #[test]
    fn the_prefix_is_four_bytes_little_endian() {
        let f = encode(br#"{"id":1}"#, MAX_MESSAGE).unwrap();
        assert_eq!(&f[..4], &[8, 0, 0, 0]);
        assert_eq!(&f[4..], br#"{"id":1}"#);
        let big = vec![b'x'; 0x0102_03];
        assert_eq!(&encode(&big, MAX_MESSAGE).unwrap()[..4], &[0x03, 0x02, 0x01, 0x00]);
    }

    #[test]
    fn round_trip_and_two_frames_in_a_row() {
        let mut stream = Vec::new();
        write(&mut stream, b"one", MAX_MESSAGE).unwrap();
        write(&mut stream, b"", MAX_MESSAGE).unwrap();
        write(&mut stream, "två".as_bytes(), MAX_MESSAGE).unwrap();
        let mut r = io::Cursor::new(stream);
        assert_eq!(read(&mut r, MAX_MESSAGE).unwrap(), b"one");
        assert_eq!(read(&mut r, MAX_MESSAGE).unwrap(), b"");
        assert_eq!(read(&mut r, MAX_MESSAGE).unwrap(), "två".as_bytes());
        assert!(matches!(read(&mut r, MAX_MESSAGE), Err(FrameError::Closed)));
    }

    #[test]
    fn one_megabyte_is_the_cap() {
        let exactly = vec![b'a'; MAX_MESSAGE];
        assert!(encode(&exactly, MAX_MESSAGE).is_ok());
        let over = vec![b'a'; MAX_MESSAGE + 1];
        assert!(matches!(encode(&over, MAX_MESSAGE), Err(FrameError::TooLarge(n)) if n == MAX_MESSAGE + 1));

        // A reader refuses the length before it allocates, and can skip the body.
        let mut stream = ((MAX_MESSAGE + 1) as u32).to_le_bytes().to_vec();
        stream.extend_from_slice(&over);
        write(&mut stream, b"next", MAX_MESSAGE).unwrap();
        let mut r = io::Cursor::new(stream);
        let Err(FrameError::TooLarge(n)) = read(&mut r, MAX_MESSAGE) else { panic!("not refused") };
        skip(&mut r, n).unwrap();
        assert_eq!(read(&mut r, MAX_MESSAGE).unwrap(), b"next");

        // A length of 4 GB is refused the same way (no allocation).
        let mut r = io::Cursor::new(u32::MAX.to_le_bytes().to_vec());
        assert!(matches!(read(&mut r, MAX_MESSAGE), Err(FrameError::TooLarge(_))));
    }

    #[test]
    fn a_stream_that_ends_inside_a_frame_is_an_error() {
        let mut r = io::Cursor::new(vec![5, 0]);
        assert!(matches!(read(&mut r, MAX_MESSAGE), Err(FrameError::Io(_))));
        let mut r = io::Cursor::new(vec![5, 0, 0, 0, b'a', b'b']);
        assert!(matches!(read(&mut r, MAX_MESSAGE), Err(FrameError::Io(_))));
    }

    #[test]
    fn async_round_trip() {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        rt.block_on(async {
            let mut out = Vec::new();
            write_async(&mut out, b"{\"a\":1}", MAX_MESSAGE).await.unwrap();
            write_async(&mut out, b"x", MAX_MESSAGE).await.unwrap();
            let mut r = io::Cursor::new(out);
            assert_eq!(read_async(&mut r, MAX_MESSAGE).await.unwrap(), b"{\"a\":1}");
            assert_eq!(read_async(&mut r, MAX_MESSAGE).await.unwrap(), b"x");
            assert!(matches!(read_async(&mut r, MAX_MESSAGE).await, Err(FrameError::Closed)));
            let mut r = io::Cursor::new(((MAX_MESSAGE + 1) as u32).to_le_bytes().to_vec());
            assert!(matches!(read_async(&mut r, MAX_MESSAGE).await, Err(FrameError::TooLarge(_))));
        });
    }
}
