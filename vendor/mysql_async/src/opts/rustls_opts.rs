#![cfg(feature = "rustls-tls")]

use rustls::pki_types::{pem, pem::PemObject, CertificateDer, PrivateKeyDer, PrivatePkcs1KeyDer};

use std::{borrow::Cow, path::Path};

use super::PathOrBuf;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ClientIdentity {
    cert_chain: PathOrBuf<'static>,
    priv_key: PathOrBuf<'static>,
}

impl ClientIdentity {
    /// Creates new identity.
    ///
    /// `cert_chain` - certificate chain (in PEM or DER)
    /// `priv_key` - private key (in DER or PEM) (it'll take the first one)
    pub fn new(cert_chain: PathOrBuf<'static>, priv_key: PathOrBuf<'static>) -> Self {
        Self {
            cert_chain,
            priv_key,
        }
    }

    /// Sets the certificate chain path (in DER or PEM).
    pub fn with_cert_chain(mut self, cert_chain: PathOrBuf<'static>) -> Self {
        self.cert_chain = cert_chain;
        self
    }

    /// Sets the private key path (in DER or PEM) (it'll take the first one).
    pub fn with_priv_key<T>(mut self, priv_key: PathOrBuf<'static>) -> Self
    where
        T: Into<Cow<'static, Path>>,
    {
        self.priv_key = priv_key;
        self
    }

    /// Returns the certificate chain.
    pub fn cert_chain(&self) -> PathOrBuf<'_> {
        self.cert_chain.borrow()
    }

    /// Returns the private key.
    pub fn priv_key(&self) -> PathOrBuf<'_> {
        self.priv_key.borrow()
    }

    pub(crate) async fn load(
        &self,
    ) -> crate::Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)> {
        let cert_data = self.cert_chain.read().await?;
        let key_data = self.priv_key.read().await?;

        let mut cert_chain = Vec::new();
        if std::str::from_utf8(&cert_data).is_err() {
            cert_chain.push(CertificateDer::from(cert_data.into_owned()));
        } else {
            for cert in pem::SliceIter::<CertificateDer<'_>>::new(&cert_data) {
                cert_chain.push(cert?);
            }
        }

        let priv_key = if std::str::from_utf8(&key_data).is_err() {
            PrivateKeyDer::Pkcs1(PrivatePkcs1KeyDer::from(key_data.into_owned()))
        } else {
            // Accept PKCS#1 (`RSA PRIVATE KEY`), PKCS#8 (`PRIVATE KEY`),
            // or SEC1 (`EC PRIVATE KEY`) PEM blocks. Preserve
            // `DriverError::NoKeyFound` for the "no PEM section present"
            // case; surface real parse errors via `TlsError::Pem`.
            match PrivateKeyDer::from_pem_slice(&key_data) {
                Ok(k) => k,
                Err(pem::Error::NoItemsFound) => {
                    return Err(crate::DriverError::NoKeyFound.into());
                }
                Err(e) => return Err(e.into()),
            }
        };

        Ok((cert_chain, priv_key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2048-bit RSA key, PKCS#1 PEM format (-----BEGIN RSA PRIVATE KEY-----)
    const PKCS1_KEY: &[u8] = b"-----BEGIN RSA PRIVATE KEY-----\n\
MIIEowIBAAKCAQEAxE2SbfMeeA4m6r3T+oZPTMTKCuwhhKV0qZgxoU/aC3STgkTR\n\
lIDbx4ukRx0pZdNvum2LlgmkKBuMQvRE5ivLkS/pKgWkKAa+zylkEr4X5tAj6o3e\n\
juvcg4ogy0CIfvyDl/l/2gLCrgc1VVsRIqM2cs1oZZVUl3f0NuixgPaoVotVjkTq\n\
Oqv+KkPWpE+mUmGlrik0jzwPcYyF3ZqlecMyqADLMXW7JByasMYd9imQHNcuojtE\n\
1Z41JaKO60sNpT1ibEZHsve1ZF1spSRD5pRgStwV8GZ+a8mmIYIahEfgyJTLrHwM\n\
Dhc00sivdsXXnynFgoTyyvOq+6KbjfDi0Fj0AQIDAQABAoIBAALWWTG4JB5ZnAPk\n\
EwKJuu8x3/a484ISjyVdYwhBGnZ0bKZjHsFd/G89rDXv7LeBTxnbd/tG7+W5gjU8\n\
iRtnkiVq0xytoLIIaO0fHMhtkXRfWUmMW+VmcNVA45j0eZSWS0Og0lGBHTW9Om7d\n\
plmBEOonYGUpe6PF0tSRV/F0fzni+rDMkmLpX14BQdzzA/cBAF7O+kTkxjOZtufe\n\
oNeEa/GwoWdlTKYtUaVx9XriEc4BDPHUPgbMQuT8Gepp/FQ1+L9TltFIyO8B4ytX\n\
KRvo3tF+E/YI7Vz4GnuYU7IL5O/fb8BZnTb0jplhbcPddF26qQTGbbPzgV8dY6wA\n\
Yy6jszECgYEA6ikNucjg0L7uQxwQz/8OCA1oFKYYPj+gmhzsW0BEZ5VzN+hDEw9J\n\
sErPp0ZNpG50+YaZPNAPxGfk6culonOAPyg3G9hnRj71S/pqSe35gnUYvc7mttcG\n\
LobMy/QerVmQRzoiR51VujrpH1wf4cT/KV7a2C/Pk1vjBuFffi3AkWkCgYEA1pyd\n\
XQqNr7c+GYX7KUnxv93fkzWtnztEoXoigqszrCpiCevWSNKNX1kHk9mIXFuoJmlZ\n\
PIIRDqOpibBCgcZu+j3R611F2if0elSPj1YNMNc1vh87brHkhNxdQpIp4YqeMSFg\n\
tX1zsrAwVIA0hoZP+TFCVODyJJBXQITTBALn4tkCgYAx6gJlAe76UFjVsVvcGpBR\n\
Ixp2nFk6m7GOaG/xm6d5NSBUYIw7udyJWckd7RyL2ofQ0OJFVkymH0dqluB92oUR\n\
8W6d3ulUzgLX6U9S5wlyx6c4fqwreXZ14IIzT5xic18P79Jy1ZT6l6gt6SNaqvWB\n\
Shj4UGi9Dq88Pjpu2S3dUQKBgQCGaJ3xyItGUphU+eF8UXBTvwyoMMUlZcQs8cYt\n\
WjXJjN3L4uVYxG2AGs0xHttVJJ5iODaIO9mc9olWz4pHptSYayFOrCL0Z3OpLc6f\n\
ccBfJ1nkUcEyKb26LB1IdSw/skYy9PmRkRll/wy1z3mWCwaJRf2KFTvyBGhw4v8Z\n\
kwxRuQKBgFwRC0AXlHArWqf3EBZmYd7OoyyspRVkzzSoWEJXNPH+G2WSmQt/lSeE\n\
nAF3k8yHWco7+bSbV3xLWsI+THNn0BNWrbfX7EAo1kWfliSy0qrevQWeaaJkd83V\n\
zmF/Qc7Ilu47gQKZWz9GASWJkOkbvJKKIDIwlIQvvXX1eDoAevmY\n\
-----END RSA PRIVATE KEY-----\n";

    // Same key, PKCS#8 PEM format (-----BEGIN PRIVATE KEY-----)
    const PKCS8_KEY: &[u8] = b"-----BEGIN PRIVATE KEY-----\n\
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDETZJt8x54Dibq\n\
vdP6hk9MxMoK7CGEpXSpmDGhT9oLdJOCRNGUgNvHi6RHHSll02+6bYuWCaQoG4xC\n\
9ETmK8uRL+kqBaQoBr7PKWQSvhfm0CPqjd6O69yDiiDLQIh+/IOX+X/aAsKuBzVV\n\
WxEiozZyzWhllVSXd/Q26LGA9qhWi1WOROo6q/4qQ9akT6ZSYaWuKTSPPA9xjIXd\n\
mqV5wzKoAMsxdbskHJqwxh32KZAc1y6iO0TVnjUloo7rSw2lPWJsRkey97VkXWyl\n\
JEPmlGBK3BXwZn5ryaYhghqER+DIlMusfAwOFzTSyK92xdefKcWChPLK86r7opuN\n\
8OLQWPQBAgMBAAECggEAAtZZMbgkHlmcA+QTAom67zHf9rjzghKPJV1jCEEadnRs\n\
pmMewV38bz2sNe/st4FPGdt3+0bv5bmCNTyJG2eSJWrTHK2gsgho7R8cyG2RdF9Z\n\
SYxb5WZw1UDjmPR5lJZLQ6DSUYEdNb06bt2mWYEQ6idgZSl7o8XS1JFX8XR/OeL6\n\
sMySYulfXgFB3PMD9wEAXs76ROTGM5m2596g14Rr8bChZ2VMpi1RpXH1euIRzgEM\n\
8dQ+BsxC5PwZ6mn8VDX4v1OW0UjI7wHjK1cpG+je0X4T9gjtXPgae5hTsgvk799v\n\
wFmdNvSOmWFtw910XbqpBMZts/OBXx1jrABjLqOzMQKBgQDqKQ25yODQvu5DHBDP\n\
/w4IDWgUphg+P6CaHOxbQERnlXM36EMTD0mwSs+nRk2kbnT5hpk80A/EZ+Tpy6Wi\n\
c4A/KDcb2GdGPvVL+mpJ7fmCdRi9zua21wYuhszL9B6tWZBHOiJHnVW6OukfXB/h\n\
xP8pXtrYL8+TW+MG4V9+LcCRaQKBgQDWnJ1dCo2vtz4ZhfspSfG/3d+TNa2fO0Sh\n\
eiKCqzOsKmIJ69ZI0o1fWQeT2YhcW6gmaVk8ghEOo6mJsEKBxm76PdHrXUXaJ/R6\n\
VI+PVg0w1zW+HztuseSE3F1Ckinhip4xIWC1fXOysDBUgDSGhk/5MUJU4PIkkFdA\n\
hNMEAufi2QKBgDHqAmUB7vpQWNWxW9wakFEjGnacWTqbsY5ob/Gbp3k1IFRgjDu5\n\
3IlZyR3tHIvah9DQ4kVWTKYfR2qW4H3ahRHxbp3e6VTOAtfpT1LnCXLHpzh+rCt5\n\
dnXggjNPnGJzXw/v0nLVlPqXqC3pI1qq9YFKGPhQaL0Orzw+Om7ZLd1RAoGBAIZo\n\
nfHIi0ZSmFT54XxRcFO/DKgwxSVlxCzxxi1aNcmM3cvi5VjEbYAazTEe21UknmI4\n\
Nog72Zz2iVbPikem1JhrIU6sIvRnc6ktzp9xwF8nWeRRwTIpvbosHUh1LD+yRjL0\n\
+ZGRGWX/DLXPeZYLBolF/YoVO/IEaHDi/xmTDFG5AoGAXBELQBeUcCtap/cQFmZh\n\
3s6jLKylFWTPNKhYQlc08f4bZZKZC3+VJ4ScAXeTzIdZyjv5tJtXfEtawj5Mc2fQ\n\
E1att9fsQCjWRZ+WJLLSqt69BZ5pomR3zdXOYX9BzsiW7juBAplbP0YBJYmQ6Ru8\n\
koogMjCUhC+9dfV4OgB6+Zg=\n\
-----END PRIVATE KEY-----\n";

    // EC P-256 private key, SEC1 PEM format (-----BEGIN EC PRIVATE KEY-----)
    const SEC1_KEY: &[u8] = b"-----BEGIN EC PRIVATE KEY-----\n\
MHcCAQEEIIfgf9+zR4IQO67je8L7RpFN7ILlUCHg8HHf2VDbIT4XoAoGCCqGSM49\n\
AwEHoUQDQgAEyhKJO00+LzRLH50nrmX8KAJK6RtqqsWnW+rfCvOBs4nnUS1yruzM\n\
5WB9UK1mVxsLVAPtNLXX0n0QvNBU6UkW7w==\n\
-----END EC PRIVATE KEY-----\n";

    // Self-signed EC certificate for the SEC1 key above
    const EC_CERT: &[u8] = b"-----BEGIN CERTIFICATE-----\n\
MIIBlDCCATmgAwIBAgIUYB9LFUfast9GdpYQRTH8LqWphD4wCgYIKoZIzj0EAwIw\n\
HjEcMBoGA1UEAwwTbXlzcWxfYXN5bmMtdGVzdC1lYzAgFw0yNjA1MjMwNjQ5MzNa\n\
GA8yMTI2MDQyOTA2NDkzM1owHjEcMBoGA1UEAwwTbXlzcWxfYXN5bmMtdGVzdC1l\n\
YzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABMoSiTtNPi80Sx+dJ65l/CgCSukb\n\
aqrFp1vq3wrzgbOJ51Etcq7szOVgfVCtZlcbC1QD7TS119J9ELzQVOlJFu+jUzBR\n\
MB0GA1UdDgQWBBSEYBKB4Y2cpNeLJCL4a444cXfQxzAfBgNVHSMEGDAWgBSEYBKB\n\
4Y2cpNeLJCL4a444cXfQxzAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kA\n\
MEYCIQCEKz/dG8PRLqE5asy+Xcja5H8EOzOdQId9rl9+UmfD2wIhAMIwy9puBewL\n\
0fndnN33G44NOnqH6QPMstJSEDX+XmyZ\n\
-----END CERTIFICATE-----\n";

    // Self-signed RSA certificate for the PKCS#1 / PKCS#8 keys above
    const CERT: &[u8] = b"-----BEGIN CERTIFICATE-----\n\
MIIC/zCCAeegAwIBAgIULM9bG/oB2Sts7i0XtMwbBjnhosswDQYJKoZIhvcNAQEL\n\
BQAwDzENMAsGA1UEAwwEdGVzdDAeFw0yNjA1MjIxMzMwMjRaFw0yNjA1MjMxMzMw\n\
MjRaMA8xDTALBgNVBAMMBHRlc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK\n\
AoIBAQDETZJt8x54DibqvdP6hk9MxMoK7CGEpXSpmDGhT9oLdJOCRNGUgNvHi6RH\n\
HSll02+6bYuWCaQoG4xC9ETmK8uRL+kqBaQoBr7PKWQSvhfm0CPqjd6O69yDiiDL\n\
QIh+/IOX+X/aAsKuBzVVWxEiozZyzWhllVSXd/Q26LGA9qhWi1WOROo6q/4qQ9ak\n\
T6ZSYaWuKTSPPA9xjIXdmqV5wzKoAMsxdbskHJqwxh32KZAc1y6iO0TVnjUloo7r\n\
Sw2lPWJsRkey97VkXWylJEPmlGBK3BXwZn5ryaYhghqER+DIlMusfAwOFzTSyK92\n\
xdefKcWChPLK86r7opuN8OLQWPQBAgMBAAGjUzBRMB0GA1UdDgQWBBQ6IWIObXB0\n\
XSoICqsjND3CIeNy8DAfBgNVHSMEGDAWgBQ6IWIObXB0XSoICqsjND3CIeNy8DAP\n\
BgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQB2jfKJEUntMcyAi28T\n\
bDc/jORi/WMIWhGjfYnxJPjzTtt6Lst3tvGhmCcAd99PKS4xXbrvwbY48FMNWcZq\n\
p1FwDzRucgafLxLJFQW26YUMltXX/P1Fh93BGjBqPomUBbXyLVeLs4+QtyLaGNSj\n\
Ijx10780osF0noZ0G3BUiXD6v3qAPOcD+29d83oiXhBeLo2OyzqUUFTJ0KR4cNjg\n\
wWBGf/Anl7ptxEVmEQvKSI8jNln6E0og3kCz4D+cIqoHUZain4IRYTwpK+kapDyQ\n\
Lf3esme5EHGvjY9cZq5jMJUYZNx67uvxdyj05dtLAg26MoXaUvojn3Kf7bOE7IKD\n\
t2kx\n\
-----END CERTIFICATE-----\n";

    fn identity(cert: &'static [u8], key: &'static [u8]) -> ClientIdentity {
        ClientIdentity::new(cert.into(), key.into())
    }

    #[tokio::test]
    async fn loads_pkcs1_key() {
        let (certs, key) = identity(CERT, PKCS1_KEY).load().await.unwrap();
        assert_eq!(certs.len(), 1);
        assert!(matches!(key, PrivateKeyDer::Pkcs1(_)));
    }

    #[tokio::test]
    async fn loads_pkcs8_key() {
        let (certs, key) = identity(CERT, PKCS8_KEY).load().await.unwrap();
        assert_eq!(certs.len(), 1);
        assert!(matches!(key, PrivateKeyDer::Pkcs8(_)));
    }

    #[tokio::test]
    async fn loads_sec1_key() {
        let (certs, key) = identity(EC_CERT, SEC1_KEY).load().await.unwrap();
        assert_eq!(certs.len(), 1);
        assert!(matches!(key, PrivateKeyDer::Sec1(_)));
    }

    #[tokio::test]
    async fn no_key_marker_returns_error() {
        let err = identity(CERT, b"not a pem key\n").load().await.unwrap_err();
        assert!(matches!(
            err,
            crate::Error::Driver(crate::DriverError::NoKeyFound)
        ));
    }
}
