use axum::http::{header::HeaderName, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

const TOKEN_HEADER: HeaderName = HeaderName::from_static("x-dbx-production-write-token");
const OPERATION_HEADER: HeaderName = HeaderName::from_static("x-dbx-production-write-operation");
const DIGEST_HEADER: HeaderName = HeaderName::from_static("x-dbx-production-write-digest");

/// Binds authorization headers to the current Axum task so core write guards
/// can validate the token without duplicating fields across every request DTO.
pub async fn middleware(req: Request<axum::body::Body>, next: Next) -> Response {
    let authorization = match authorization_from_headers(req.headers()) {
        Ok(authorization) => authorization,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    dbx_core::production_safety::with_production_write_authorization(authorization, next.run(req)).await
}

fn authorization_from_headers(
    headers: &axum::http::HeaderMap,
) -> Result<Option<dbx_core::production_safety::ProductionWriteAuthorization>, &'static str> {
    let token = header_value(headers, &TOKEN_HEADER)?;
    let operation = header_value(headers, &OPERATION_HEADER)?;
    let request_digest = header_value(headers, &DIGEST_HEADER)?;
    if token.is_none() && operation.is_none() && request_digest.is_none() {
        return Ok(None);
    }
    let (Some(token), Some(operation), Some(request_digest)) = (token, operation, request_digest) else {
        return Err("Incomplete production write authorization headers");
    };
    Ok(Some(dbx_core::production_safety::ProductionWriteAuthorization { token, operation, request_digest }))
}

fn header_value(headers: &axum::http::HeaderMap, name: &HeaderName) -> Result<Option<String>, &'static str> {
    headers
        .get(name)
        .map(|value| value.to_str().map(str::to_string).map_err(|_| "Invalid production write authorization header"))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::{authorization_from_headers, DIGEST_HEADER, OPERATION_HEADER, TOKEN_HEADER};
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn production_authorization_headers_must_be_complete() {
        let mut headers = HeaderMap::new();
        headers.insert(TOKEN_HEADER, HeaderValue::from_static("token"));
        assert!(authorization_from_headers(&headers).is_err());

        headers.insert(OPERATION_HEADER, HeaderValue::from_static("redisSetString"));
        headers.insert(
            DIGEST_HEADER,
            HeaderValue::from_static("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        );
        let authorization = authorization_from_headers(&headers).unwrap().unwrap();
        assert_eq!(authorization.token, "token");
        assert_eq!(authorization.operation, "redisSetString");
    }
}
