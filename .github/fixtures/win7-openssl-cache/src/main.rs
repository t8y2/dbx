fn main() {
    let _ = unsafe { openssl_sys::OpenSSL_version_num() };
}
