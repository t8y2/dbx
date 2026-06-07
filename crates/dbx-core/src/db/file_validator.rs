use std::path::Path;

/// Validates a file path for database connections.
///
/// Performs comprehensive checks including:
/// - Empty path validation
/// - Null character detection
/// - File existence (for local paths)
/// - File type validation (must be a file, not directory)
/// - Network path detection (skips validation for network paths)
///
/// # Arguments
/// * `path` - The file path to validate
/// * `is_network_path` - Closure to determine if path is a network path
///
/// # Returns
/// * `Ok(())` if validation passes
/// * `Err(String)` with descriptive error message if validation fails
pub fn validate_file_path<F>(path: &str, is_network_path: F) -> Result<(), String>
where
    F: Fn(&str) -> bool,
{
    // Check if path is empty
    if path.is_empty() {
        return Err("Database file path cannot be empty".to_string());
    }

    // Check if path contains invalid characters
    if path.contains('\0') {
        return Err("Database file path contains null characters".to_string());
    }

    let path_obj = Path::new(path);

    // For non-network paths, perform file system checks
    if !is_network_path(path) {
        if !path_obj.exists() {
            return Err(format!("Database file does not exist: {}", path));
        }

        // Check if path is actually a file, not a directory
        if path_obj.is_dir() {
            return Err(format!("Database file path is a directory, not a file: {}", path));
        }

        // Check if path is a valid file
        if !path_obj.is_file() {
            return Err(format!("Database file path is not a valid file: {}", path));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_network_path_test(path: &str) -> bool {
        path.starts_with("\\\\") || path.starts_with("//")
    }

    #[test]
    fn test_empty_path() {
        let result = validate_file_path("", is_network_path_test);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn test_null_character() {
        let result = validate_file_path("path\0invalid", is_network_path_test);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("null"));
    }

    #[test]
    fn test_network_path_skips_validation() {
        let result = validate_file_path("//network/path/nonexistent.db", is_network_path_test);
        assert!(result.is_ok());
    }

    #[test]
    fn test_nonexistent_local_file() {
        let result = validate_file_path("/nonexistent/path/to/file.db", is_network_path_test);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));
    }
}
