use std::io::IoSlice;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use base16ct::lower;
use delegate::delegate;
use log::debug;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use crate::windows::Win32::Foundation::ERROR_PIPE_BUSY;
use crate::windows::Win32::Security::Authentication::Identity::{GetUserNameExA, NameUserPrincipal};
use crate::windows::Win32::Security::Cryptography::{
    CRYPTPROTECTMEMORY_BLOCK_SIZE, CRYPTPROTECTMEMORY_CROSS_PROCESS, CryptProtectMemory,
};
use crate::windows::Win32::System::WindowsProgramming::GetUserNameA;
use crate::windows::core::PSTR;

use crate::Error;
use crate::username::{UsernameLookupError, format_pipe_name, resolve_username};

/// Pageant transport stream. Implements [AsyncRead] and [AsyncWrite].
pub struct PageantStream {
    stream: NamedPipeClient,
}

impl PageantStream {
    pub async fn new() -> Result<Self, Error> {
        let pipe_name = Self::determine_pipe_name()?;
        debug!("Opening pipe '{}'", pipe_name);
        let mut timeout_counter = 0;
        let stream = loop {
            match ClientOptions::new().open(&pipe_name) {
                Ok(client) => break client,
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY.0 as i32) => (),
                Err(e) => return Err(e.into()),
            }
            timeout_counter += 1;
            if timeout_counter > 40 {
                return Err(Error::PipeBusy);
            }

            tokio::time::sleep(Duration::from_millis(50)).await;
        };

        Ok(Self { stream })
    }

    fn determine_pipe_name() -> Result<String, Error> {
        let username = Self::get_username()?;
        let suffix = Self::capi_obfuscate_string("Pageant")?;
        Ok(format_pipe_name(&username, &suffix))
    }

    fn get_username() -> Result<String, Error> {
        match resolve_username(Self::get_principal_username(), Self::get_local_username) {
            Ok(username) => Ok(username),
            Err(UsernameLookupError::Api(error)) => Err(error),
            Err(UsernameLookupError::Invalid) => Err(Error::InvalidUsername),
        }
    }

    fn get_principal_username() -> Result<Vec<u8>, Error> {
        unsafe {
            let mut name_length = 0;
            GetUserNameExA(NameUserPrincipal, None, &mut name_length);
            if name_length == 0 {
                return Ok(Vec::new());
            }

            let mut name_buf = vec![0u8; name_length as usize];
            if GetUserNameExA(
                NameUserPrincipal,
                Some(PSTR(name_buf.as_mut_ptr())),
                &mut name_length,
            ) {
                Ok(name_buf)
            } else {
                Err(Error::from_win32())
            }
        }
    }

    fn get_local_username() -> Result<Vec<u8>, Error> {
        unsafe {
            let mut name_length = 0;
            let size_result = GetUserNameA(None, &mut name_length);
            if name_length == 0 {
                return match size_result {
                    Ok(()) => Ok(Vec::new()),
                    Err(error) => Err(error.into()),
                };
            }

            let mut name_buf = vec![0u8; name_length as usize];
            GetUserNameA(Some(PSTR(name_buf.as_mut_ptr())), &mut name_length)?;
            Ok(name_buf)
        }
    }

    fn capi_obfuscate_string(input: &str) -> Result<String, Error> {
        let mut cryptlen = input.len() + 1;
        cryptlen = cryptlen.next_multiple_of(CRYPTPROTECTMEMORY_BLOCK_SIZE as usize);
        let mut cryptdata = vec![0u8; cryptlen];

        // copy cleartext into crypt buffer:
        cryptdata
            .iter_mut()
            .zip(input.as_bytes())
            .for_each(|(c, i)| *c = *i);
        // (since the buffer is initialized to 0 and always at least 1 longer than the input,
        // we don't need to worry about terminating the string)

        unsafe {
            // Errors are explicitly ignored:
            let _ = CryptProtectMemory(
                cryptdata.as_mut_ptr() as *mut _,
                cryptlen as u32,
                CRYPTPROTECTMEMORY_CROSS_PROCESS,
            );
        }

        let mut hasher = Sha256::new();
        hasher.update((cryptdata.len() as u32).to_be_bytes());
        hasher.update(&cryptdata);
        Ok(lower::encode_string(&hasher.finalize()))
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
