use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;

pub struct DownloadFile {
    destination: PathBuf,
    temporary: PathBuf,
    file: Option<File>,
}

impl DownloadFile {
    pub fn new(destination: PathBuf, id: &str) -> io::Result<Self> {
        let name = destination.file_name().ok_or_else(|| io::Error::other("Missing destination filename"))?;
        let mut temporary_name = std::ffi::OsString::from(".");
        temporary_name.push(name);
        temporary_name.push(format!(".{id}.part"));
        let temporary = destination.with_file_name(temporary_name);
        let file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        Ok(Self { destination, temporary, file: Some(file) })
    }

    pub fn commit(&mut self) -> io::Result<()> {
        if let Some(file) = self.file.take() {
            file.sync_all()?;
        }
        std::fs::rename(&self.temporary, &self.destination)
    }
}

impl Write for DownloadFile {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.file.as_mut().ok_or_else(|| io::Error::other("Download is closed"))?.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.as_mut().ok_or_else(|| io::Error::other("Download is closed"))?.flush()
    }
}

impl Drop for DownloadFile {
    fn drop(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.temporary);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_preserves_existing_destination() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("report.bin");
        std::fs::write(&destination, b"original").unwrap();
        {
            let mut output = DownloadFile::new(destination.clone(), "cancel").unwrap();
            output.write_all(b"partial").unwrap();
            assert_eq!(std::fs::read(&destination).unwrap(), b"original");
        }
        assert_eq!(std::fs::read(&destination).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn success_replaces_destination_only_after_completion() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("报告.bin");
        std::fs::write(&destination, b"original").unwrap();
        let mut output = DownloadFile::new(destination.clone(), "complete").unwrap();
        for _ in 0..300 {
            output.write_all(&vec![7; 1024 * 1024]).unwrap();
        }
        assert_eq!(std::fs::read(&destination).unwrap(), b"original");
        output.commit().unwrap();
        assert_eq!(std::fs::metadata(&destination).unwrap().len(), 300 * 1024 * 1024);
        drop(output);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
