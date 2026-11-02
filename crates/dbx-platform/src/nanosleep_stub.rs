/// 为 WinLibs MinGW-w64 (POSIX UCRT) 提供 nanosleep64 桩实现。
///
/// WinLibs 的 pthread 头文件声明了 `nanosleep64`，但 `libpthread.a` 库中
/// 未导出该符号，导致 `aws-lc-sys` 等依赖的 C 代码链接失败。
/// 此模块仅在 `x86_64-pc-windows-gnu` 目标下编译，提供一个弱符号桩
/// 来满足链接器需求。该函数仅用于线程退避计时，非关键路径。
#[cfg(all(target_os = "windows", target_env = "gnu"))]
use std::time::Duration;

#[cfg(all(target_os = "windows", target_env = "gnu"))]
#[repr(C)]
struct Timespec64 {
    tv_sec: i64,  // __time64_t — Windows 上始终为 64 位
    tv_nsec: i32, // long — Windows 上始终为 32 位
}

/// nanosleep64 桩实现：使用 std::thread::sleep 替代。
/// 当 WinLibs 更新并正确导出该符号后，可移除此模块。
#[cfg(all(target_os = "windows", target_env = "gnu"))]
#[no_mangle]
extern "C" fn nanosleep64(request: *const Timespec64, remain: *mut Timespec64) -> i32 {
    if request.is_null() {
        return -1;
    }
    unsafe {
        let ms = ((*request).tv_sec * 1000).saturating_add((*request).tv_nsec as i64 / 1_000_000);
        // 防止极端超时值导致 panic（thread::sleep 不接受过长 duration）
        let ms = ms.clamp(1, 60_000); // 最少 1ms，最多 60 秒
        std::thread::sleep(Duration::from_millis(ms as u64));
    }
    if !remain.is_null() {
        unsafe {
            (*remain).tv_sec = 0;
            (*remain).tv_nsec = 0;
        }
    }
    0
}
