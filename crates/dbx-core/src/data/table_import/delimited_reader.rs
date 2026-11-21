use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};

pub(super) enum DelimitedReader<R: Read> {
    Single(csv::Reader<R>),
    Multi(MultiDelimiterReader<R>),
}

impl<R: Read> DelimitedReader<R> {
    pub(super) fn new(input: R, delimiter: &[u8]) -> Self {
        if delimiter.len() <= 1 {
            let byte = delimiter.first().copied().unwrap_or(b',');
            return Self::Single(
                csv::ReaderBuilder::new().delimiter(byte).has_headers(false).flexible(true).from_reader(input),
            );
        }
        Self::Multi(MultiDelimiterReader {
            input: BufReader::new(input),
            delimiter: delimiter.to_vec(),
            pending: VecDeque::new(),
            field: Vec::new(),
        })
    }

    pub(super) fn get_ref(&self) -> &R {
        match self {
            Self::Single(reader) => reader.get_ref(),
            Self::Multi(reader) => reader.input.get_ref(),
        }
    }

    pub(super) fn read_record(&mut self, record: &mut csv::StringRecord) -> Result<bool, String> {
        match self {
            Self::Single(reader) => reader.read_record(record).map_err(|error| error.to_string()),
            Self::Multi(reader) => reader.read_record(record),
        }
    }
}

impl<R: Read> From<csv::Reader<R>> for DelimitedReader<R> {
    fn from(reader: csv::Reader<R>) -> Self {
        Self::Single(reader)
    }
}

#[derive(Clone, Copy)]
enum FieldState {
    Start,
    Unquoted,
    Quoted,
    AfterQuote,
}

pub(super) struct MultiDelimiterReader<R> {
    input: BufReader<R>,
    delimiter: Vec<u8>,
    pending: VecDeque<u8>,
    field: Vec<u8>,
}

impl<R: Read> MultiDelimiterReader<R> {
    fn read_record(&mut self, record: &mut csv::StringRecord) -> Result<bool, String> {
        record.clear();
        self.field.clear();
        let mut state = FieldState::Start;
        while let Some(byte) = self.next_byte()? {
            match (state, byte) {
                (FieldState::Quoted, b'"') => state = FieldState::AfterQuote,
                (FieldState::Quoted, _) => self.field.push(byte),
                (FieldState::AfterQuote, b'"') => {
                    self.field.push(byte);
                    state = FieldState::Quoted;
                }
                (FieldState::Start, b'"') => state = FieldState::Quoted,
                (_, b'\r' | b'\n') => {
                    // Match csv::Reader: ignore empty physical lines, including the LF after a CR.
                    if !record.is_empty() || !matches!(state, FieldState::Start) {
                        self.finish_field(record)?;
                        return Ok(true);
                    }
                }
                _ if self.consume_delimiter(byte)? => {
                    self.finish_field(record)?;
                    state = FieldState::Start;
                }
                _ => {
                    self.field.push(byte);
                    state = FieldState::Unquoted;
                }
            }
        }
        if record.is_empty() && matches!(state, FieldState::Start) {
            return Ok(false);
        }
        self.finish_field(record)?;
        Ok(true)
    }

    fn finish_field(&mut self, record: &mut csv::StringRecord) -> Result<(), String> {
        record.push_field(std::str::from_utf8(&self.field).map_err(|error| error.to_string())?);
        self.field.clear();
        Ok(())
    }

    fn next_byte(&mut self) -> Result<Option<u8>, String> {
        match self.pending.pop_front() {
            Some(byte) => Ok(Some(byte)),
            None => read_byte(&mut self.input),
        }
    }

    fn consume_delimiter(&mut self, first: u8) -> Result<bool, String> {
        if first != self.delimiter[0] {
            return Ok(false);
        }
        // A partial match is still field data. Keep lookahead for the next iteration,
        // including when another delimiter starts within the failed match.
        for (index, expected) in self.delimiter[1..].iter().enumerate() {
            if self.pending.len() == index {
                let Some(byte) = read_byte(&mut self.input)? else {
                    return Ok(false);
                };
                self.pending.push_back(byte);
            }
            if self.pending[index] != *expected {
                return Ok(false);
            }
        }
        self.pending.drain(..self.delimiter.len() - 1);
        Ok(true)
    }
}

fn read_byte(input: &mut impl BufRead) -> Result<Option<u8>, String> {
    let byte = input.fill_buf().map_err(|error| error.to_string())?.first().copied();
    if byte.is_some() {
        input.consume(1);
    }
    Ok(byte)
}
