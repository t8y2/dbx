// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

/// Takes a version and spits out a String with trailing _x, thus only considering the digits
/// relevant regarding semver compatibility
pub fn semver_compat_string(version: &semver::Version) -> String {
    // for pre-release always treat each version separately
    if !version.pre.is_empty() {
        return version.to_string().replace(['.', '-'], "_");
    }
    match version.major {
        0 => match version.minor {
            0 => format!("0_0_{}", version.patch),
            _ => format!("0_{}_x", version.minor),
        },
        _ => format!("{}_x_x", version.major),
    }
}
