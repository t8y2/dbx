use std::ffi::CString;
use std::io::IoSlice;
use std::pin::Pin;
use std::task::{Context, Poll};

use byteorder::{BigEndian, ByteOrder};
use bytes::BytesMut;
use delegate::delegate;
use log::debug;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf};
use crate::windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM, WPARAM};
use crate::windows::Win32::Security::{
    GetTokenInformation, InitializeSecurityDescriptor, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
    SECURITY_DESCRIPTOR, SetSecurityDescriptorOwner, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use crate::windows::Win32::System::DataExchange::COPYDATASTRUCT;
use crate::windows::Win32::System::Memory::{
    CreateFileMappingW, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile, PAGE_READWRITE,
    UnmapViewOfFile,
};
use crate::windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use crate::windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SendMessageA, WM_COPYDATA};
use crate::windows::core::PCWSTR;

use crate::Error;

/// Pageant transport stream. Implements [AsyncRead] and [AsyncWrite].
///
/// The stream has a unique cookie and requests made in the same stream are considered the same "session".
pub struct PageantStream {
    stream: DuplexStream,
}

impl PageantStream {
    pub async fn new() -> Result<Self, Error> {
        let (one, mut two) = tokio::io::duplex(_AGENT_MAX_MSGLEN * 100);

        let cookie = rand::random::<u64>().to_string();
        tokio::spawn(async move {
            let mut buf = BytesMut::new();
            while let Ok(n) = two.read_buf(&mut buf).await {
                if n == 0 {
                    break;
                }
                if buf.len() < 4 {
                    continue;
                }
                let len = BigEndian::read_u32(&buf) as usize;
                if buf.len() < len + 4 {
                    continue;
                }
                let msg = buf.split_to(len + 4).freeze();
                let Ok(response) = query_pageant_direct(cookie.clone(), &msg).map_err(|e| {
                    debug!("Pageant query failed: {:?}", e);
                    e
                }) else {
                    break;
                };
                two.write_all(&response).await?
            }
            std::io::Result::Ok(())
        });

        Ok(Self { stream: one })
    }
}

impl AsyncRead for PageantStream {
    delegate! {
        to Pin::new(&mut self.stream) {
            fn poll_read(
                mut self: Pin<&mut Self>,
                cx: &mut Context<'_>,
                buf: &mut ReadBuf<'_>,
            ) -> Poll<Result<(), std::io::Error>>;

        }
    }
}

impl AsyncWrite for PageantStream {
    delegate! {
        to Pin::new(&mut self.stream) {
            fn poll_write(
                mut self: Pin<&mut Self>,
                cx: &mut Context<'_>,
                buf: &[u8],
            ) -> Poll<Result<usize, std::io::Error>>;

            fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), std::io::Error>>;

            fn poll_write_vectored(
                mut self: Pin<&mut Self>,
                cx: &mut Context<'_>,
                bufs: &[IoSlice<'_>],
            ) -> Poll<Result<usize, std::io::Error>>;

            fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), std::io::Error>>;
        }

        to Pin::new(&self.stream) {
            fn is_write_vectored(&self) -> bool;
        }
    }
}

struct MemoryMap {
    filemap: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    length: usize,
    pos: usize,
}

impl MemoryMap {
    fn new(
        name: String,
        length: usize,
        security_attributes: Option<SECURITY_ATTRIBUTES>,
    ) -> Result<Self, Error> {
        let wide_name = wide_null(&name);
        let filemap = unsafe {
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                security_attributes.map(|sa| &sa as *const _),
                PAGE_READWRITE,
                0,
                length as u32,
                PCWSTR(wide_name.as_ptr()),
            )
        }?;
        if filemap.is_invalid() {
            return Err(Error::from_win32());
        }
        let view = unsafe { MapViewOfFile(filemap, FILE_MAP_WRITE, 0, 0, 0) };
        Ok(Self {
            filemap,
            view,
            length,
            pos: 0,
        })
    }

    fn seek(&mut self, pos: usize) {
        self.pos = pos;
    }

    fn write(&mut self, data: &[u8]) -> Result<(), Error> {
        if self.pos + data.len() > self.length {
            return Err(Error::Overflow);
        }

        if data.is_empty() {
            return Ok(());
        }

        unsafe {
            #[allow(clippy::indexing_slicing)] // length checked
            std::ptr::copy_nonoverlapping(
                &data[0] as *const u8,
                self.view.Value.add(self.pos) as *mut u8,
                data.len(),
            );
        }
        self.pos += data.len();
        Ok(())
    }

    fn read(&mut self, n: usize) -> Vec<u8> {
        let out = vec![0; n];
        unsafe {
            std::ptr::copy_nonoverlapping(
                self.view.Value.add(self.pos) as *const u8,
                out.as_ptr() as *mut u8,
                n,
            );
        }
        self.pos += n;
        out
    }
}

impl Drop for MemoryMap {
    fn drop(&mut self) {
        unsafe {
            let _ = UnmapViewOfFile(self.view);
            let _ = CloseHandle(self.filemap);
        }
    }
}

fn find_pageant_window() -> Result<HWND, Error> {
    let pageant = wide_null("Pageant");
    let w = unsafe { FindWindowW(PCWSTR(pageant.as_ptr()), PCWSTR(pageant.as_ptr())) }?;
    if w.is_invalid() {
        return Err(Error::NotFound);
    }
    Ok(w)
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

const _AGENT_COPYDATA_ID: u64 = 0x804E50BA;
const _AGENT_MAX_MSGLEN: usize = 8192;

pub fn is_pageant_running() -> bool {
    find_pageant_window().is_ok()
}

fn get_current_process_user() -> Result<TOKEN_USER, Error> {
    unsafe {
        let mut process_token = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY,
            &mut process_token as *mut _,
        )?;

        let mut info_size = 0;
        let _ = GetTokenInformation(process_token, TokenUser, None, 0, &mut info_size);

        let mut buffer = vec![0; info_size as usize];
        GetTokenInformation(
            process_token,
            TokenUser,
            Some(buffer.as_mut_ptr() as *mut _),
            buffer.len() as u32,
            &mut info_size,
        )?;
        let user: TOKEN_USER = *(buffer.as_ptr() as *const _);
        let _ = CloseHandle(process_token);
        Ok(user)
    }
}

/// Send a one-off query to Pageant and return a response.
pub fn query_pageant_direct(cookie: String, msg: &[u8]) -> Result<Vec<u8>, Error> {
    let hwnd = find_pageant_window()?;
    let map_name = format!("PageantRequest{cookie}");

    let user = get_current_process_user()?;

    let mut sd = SECURITY_DESCRIPTOR::default();
    let sa = SECURITY_ATTRIBUTES {
        lpSecurityDescriptor: &mut sd as *mut _ as *mut _,
        bInheritHandle: true.into(),
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
    };

    let psd = PSECURITY_DESCRIPTOR(&mut sd as *mut _ as *mut _);

    unsafe {
        InitializeSecurityDescriptor(psd, 1)?;
        SetSecurityDescriptorOwner(psd, Some(user.User.Sid), false)?;
    }

    let mut map: MemoryMap = MemoryMap::new(map_name.clone(), _AGENT_MAX_MSGLEN, Some(sa))?;
    map.write(msg)?;

    let char_buffer = CString::new(map_name.as_bytes()).map_err(|_| Error::InvalidCookie)?;
    let cds = COPYDATASTRUCT {
        dwData: _AGENT_COPYDATA_ID as usize,
        cbData: char_buffer.as_bytes().len() as u32,
        lpData: char_buffer.as_bytes().as_ptr() as *mut _,
    };

    let response = unsafe {
        SendMessageA(
            hwnd,
            WM_COPYDATA,
            WPARAM(0), // Should be window handle to requesting app, which we don't have
            LPARAM(&cds as *const _ as isize),
        )
    };

    if response.0 == 0 {
        return Err(Error::NoResponse);
    }

    map.seek(0);
    let mut buf = map.read(4);
    if buf.len() < 4 {
        return Err(Error::NoResponse);
    }
    #[allow(clippy::indexing_slicing)] // length checked
    let size = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    buf.extend(map.read(size));

    Ok(buf)
}
