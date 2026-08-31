#[derive(Debug, PartialEq)]
pub(crate) enum UsernameLookupError<E> {
    Api(E),
    Invalid,
}

#[derive(Debug, PartialEq)]
enum UsernameParseError {
    Empty,
    Invalid,
}

pub(crate) fn resolve_username<E>(
    principal: Result<Vec<u8>, E>,
    local: impl FnOnce() -> Result<Vec<u8>, E>,
) -> Result<String, UsernameLookupError<E>> {
    if let Ok(buffer) = principal {
        match parse_username(buffer) {
            Ok(username) => return Ok(username),
            Err(UsernameParseError::Invalid) => return Err(UsernameLookupError::Invalid),
            Err(UsernameParseError::Empty) => {}
        }
    }

    parse_username(local().map_err(UsernameLookupError::Api)?).map_err(|_| UsernameLookupError::Invalid)
}

fn parse_username(mut buffer: Vec<u8>) -> Result<String, UsernameParseError> {
    if buffer.is_empty() {
        return Err(UsernameParseError::Empty);
    }
    if buffer.last() != Some(&0) {
        return Err(UsernameParseError::Invalid);
    }
    while buffer.last() == Some(&0) {
        buffer.pop();
    }
    if buffer.contains(&0) {
        return Err(UsernameParseError::Invalid);
    }
    let username = std::str::from_utf8(&buffer).map_err(|_| UsernameParseError::Invalid)?;
    let username = username.rsplit_once('\\').map_or(username, |(_, username)| username);
    let username = username.split_once('@').map_or(username, |(username, _)| username);
    if username.is_empty() { Err(UsernameParseError::Empty) } else { Ok(username.to_owned()) }
}

pub(crate) fn format_pipe_name(username: &str, suffix: &str) -> String {
    format!("\\\\.\\pipe\\pageant.{username}.{suffix}")
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[derive(Debug, PartialEq)]
    enum ApiError {
        Principal,
        Local,
    }

    #[test]
    fn normalizes_principal_and_sam_names() {
        assert_eq!(parse_username(b"alice@example.com\0".to_vec()), Ok("alice".to_owned()));
        assert_eq!(parse_username(b"DOMAIN\\alice\0".to_vec()), Ok("alice".to_owned()));
    }

    #[test]
    fn accepts_only_trailing_username_buffer_padding() {
        assert_eq!(parse_username(b"Shaan\0\0\0\0\0\0\0".to_vec()), Ok("Shaan".to_owned()));
        assert_eq!(format_pipe_name("Shaan", "0123abcd"), "\\\\.\\pipe\\pageant.Shaan.0123abcd");
        assert_eq!(parse_username(b"alice\0unexpected\0".to_vec()), Err(UsernameParseError::Invalid));
    }

    #[test]
    fn falls_back_when_principal_is_empty() {
        for principal in [Vec::new(), vec![0]] {
            let local_called = Cell::new(false);
            let username = resolve_username::<ApiError>(Ok(principal), || {
                local_called.set(true);
                Ok(b"local_user\0".to_vec())
            });

            assert_eq!(username, Ok("local_user".to_owned()));
            assert!(local_called.get());
        }
    }

    #[test]
    fn falls_back_when_principal_lookup_fails() {
        assert_eq!(
            resolve_username(Err(ApiError::Principal), || Ok(b"local_user\0".to_vec())),
            Ok("local_user".to_owned())
        );
    }

    #[test]
    fn preserves_the_local_api_error_when_both_lookups_fail() {
        assert_eq!(
            resolve_username::<ApiError>(Err(ApiError::Principal), || Err(ApiError::Local)),
            Err(UsernameLookupError::Api(ApiError::Local))
        );
    }

    #[test]
    fn rejects_invalid_utf8_without_falling_back() {
        let local_called = Cell::new(false);
        let result = resolve_username::<ApiError>(Ok(vec![0xff, 0]), || {
            local_called.set(true);
            Ok(b"local_user\0".to_vec())
        });

        assert_eq!(result, Err(UsernameLookupError::Invalid));
        assert!(!local_called.get());
        assert_eq!(
            resolve_username::<ApiError>(Err(ApiError::Principal), || Ok(vec![0xff, 0])),
            Err(UsernameLookupError::Invalid)
        );
    }

    #[test]
    fn rejects_missing_terminators() {
        assert_eq!(parse_username(b"alice".to_vec()), Err(UsernameParseError::Invalid));
        assert_eq!(parse_username(Vec::new()), Err(UsernameParseError::Empty));
    }

    #[test]
    fn keeps_the_pageant_pipe_suffix_unchanged() {
        assert_eq!(format_pipe_name("alice", "0123abcd"), "\\\\.\\pipe\\pageant.alice.0123abcd");
    }
}
