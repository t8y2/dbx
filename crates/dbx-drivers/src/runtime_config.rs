pub const DUCKDB_WORKER_MAX_PROCESSES_MIN: usize = 1;
pub const DUCKDB_WORKER_MAX_PROCESSES_MAX: usize = 16;
pub const DUCKDB_WORKER_MAX_PROCESSES_DEFAULT: usize = 4;

pub fn normalize_duckdb_worker_max_processes(value: usize) -> usize {
    value.clamp(DUCKDB_WORKER_MAX_PROCESSES_MIN, DUCKDB_WORKER_MAX_PROCESSES_MAX)
}
