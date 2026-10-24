//! Bounded Pickle protocols 0-5 interpreter. Globals are metadata, never code.
use crate::redis_codec_support::{DecodeBudget, MAX_DEPTH, MAX_INPUT_BYTES};
use base64::Engine;
use num_bigint::BigInt;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

type Id = usize;
type Result<T> = std::result::Result<T, ()>;

enum Node {
    Scalar(Value),
    Bytes(Vec<u8>),
    List(Vec<Id>),
    Tuple(Vec<Id>),
    Set(Vec<Id>),
    FrozenSet(Vec<Id>),
    Dict(Vec<(Id, Id)>),
    Global(String),
    Instance { class: String, args: Id, state: Option<Id>, show_state: bool },
}

pub fn decode_pickle_with_budget(bytes: &[u8], remaining: &mut usize) -> Option<Value> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return None;
    }
    let mut budget = DecodeBudget::new(remaining);
    budget.spend(bytes.len()).ok()?;
    let mut parser = Parser {
        bytes,
        pos: 0,
        frame: None,
        stack: Vec::new(),
        marks: Vec::new(),
        memo: HashMap::new(),
        arena: Vec::new(),
        budget,
    };
    let root = parser.load().ok()?;
    parser.normalize(root, 0, &mut HashSet::new(), &mut HashSet::new()).ok()
}

struct Parser<'a, 'b> {
    bytes: &'a [u8],
    pos: usize,
    frame: Option<usize>,
    stack: Vec<Id>,
    marks: Vec<usize>,
    memo: HashMap<usize, Id>,
    arena: Vec<Node>,
    budget: DecodeBudget<'b>,
}

impl Parser<'_, '_> {
    fn read(&mut self, count: usize) -> Result<&[u8]> {
        let end = self.pos.checked_add(count).ok_or(())?;
        if end > self.bytes.len() || self.frame.is_some_and(|limit| end > limit) {
            return Err(());
        }
        let data = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(data)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.read(1)?[0])
    }
    fn uint(&mut self, count: usize) -> Result<usize> {
        let mut value = 0u64;
        for (offset, byte) in self.read(count)?.iter().enumerate() {
            value |= u64::from(*byte) << (8 * offset);
        }
        usize::try_from(value).map_err(|_| ())
    }
    fn line(&mut self) -> Result<Vec<u8>> {
        let limit = self.frame.unwrap_or(self.bytes.len());
        let count = self.bytes[self.pos..limit].iter().position(|byte| *byte == b'\n').ok_or(())?;
        self.budget.spend(count.checked_mul(4).ok_or(())?)?;
        let bytes = self.read(count)?.to_vec();
        self.byte()?;
        Ok(bytes)
    }
    fn text_line(&mut self) -> Result<String> {
        Ok(self.line()?.iter().map(|v| char::from(*v)).collect())
    }
    fn add(&mut self, node: Node) -> Result<Id> {
        self.budget.node(0)?;
        let id = self.arena.len();
        self.arena.push(node);
        Ok(id)
    }
    fn push(&mut self, id: Id) -> Result<()> {
        self.budget.spend(8)?;
        self.stack.push(id);
        Ok(())
    }
    fn emit(&mut self, node: Node) -> Result<()> {
        let id = self.add(node)?;
        self.push(id)
    }
    fn scalar(&mut self, value: Value) -> Result<()> {
        self.emit(Node::Scalar(value))
    }
    fn pop(&mut self) -> Result<Id> {
        if self.stack.len() <= self.marks.last().copied().unwrap_or(0) {
            return Err(());
        }
        self.stack.pop().ok_or(())
    }
    fn peek(&self) -> Result<Id> {
        if self.stack.len() <= self.marks.last().copied().unwrap_or(0) {
            return Err(());
        }
        self.stack.last().copied().ok_or(())
    }
    fn marked(&mut self) -> Result<Vec<Id>> {
        let mark = self.marks.pop().ok_or(())?;
        self.budget.spend((self.stack.len() - mark).checked_mul(8).ok_or(())?)?;
        Ok(self.stack.split_off(mark))
    }
    fn data(&mut self, count: usize, bytes: bool, latin: bool) -> Result<()> {
        self.budget.spend(count.checked_mul(4).ok_or(())?)?;
        let data = self.read(count)?;
        let node = if bytes {
            Node::Bytes(data.to_vec())
        } else {
            let text = if latin {
                data.iter().map(|v| char::from(*v)).collect()
            } else {
                let text = std::str::from_utf8(data).map_err(|_| ())?;
                text.strip_prefix('\u{feff}').unwrap_or(text).to_owned()
            };
            Node::Scalar(Value::String(text))
        };
        self.emit(node)
    }
    fn int(&mut self, value: BigInt) -> Result<()> {
        let value =
            if value >= BigInt::from(-9_007_199_254_740_991i64) && value <= BigInt::from(9_007_199_254_740_991i64) {
                Value::Number(value.to_string().parse::<i64>().map_err(|_| ())?.into())
            } else {
                Value::String(value.to_string())
            };
        self.scalar(value)
    }
    fn pairs(items: Vec<Id>) -> Result<Vec<(Id, Id)>> {
        if !items.len().is_multiple_of(2) {
            return Err(());
        }
        Ok(items.chunks_exact(2).map(|pair| (pair[0], pair[1])).collect())
    }
    fn load(&mut self) -> Result<Id> {
        loop {
            if self.frame == Some(self.pos) {
                self.frame = None;
            }
            self.budget.spend(1)?;
            let start = self.pos;
            let opcode = self.byte()?;
            match opcode {
                b'.' => {
                    if self.pos != self.bytes.len()
                        || self.frame.is_some_and(|end| end != self.pos)
                        || !self.marks.is_empty()
                        || self.stack.len() != 1
                    {
                        return Err(());
                    }
                    return self.pop();
                }
                0x80 => {
                    if start != 0 || self.byte()? > 5 {
                        return Err(());
                    }
                }
                0x95 => {
                    if self.frame.is_some() {
                        return Err(());
                    }
                    let length = self.uint(8)?;
                    let end = self.pos.checked_add(length).ok_or(())?;
                    if end > self.bytes.len() {
                        return Err(());
                    }
                    self.frame = Some(end);
                }
                b'N' => self.scalar(Value::Null)?,
                0x88 => self.scalar(Value::Bool(true))?,
                0x89 => self.scalar(Value::Bool(false))?,
                b'I' | b'L' => {
                    let mut text = self.text_line()?;
                    if opcode == b'I' && (text == "00" || text == "01") {
                        self.scalar(Value::Bool(text == "01"))?;
                    } else {
                        if opcode == b'L' && text.ends_with('L') {
                            text.pop();
                        }
                        // Bound decimal conversion as well as the encoded input.
                        if text.len() > 4096 {
                            return Err(());
                        }
                        self.budget.spend(text.len().checked_mul(8).ok_or(())?)?;
                        self.int(text.parse::<BigInt>().map_err(|_| ())?)?;
                    }
                }
                b'J' => {
                    let data: [u8; 4] = self.read(4)?.try_into().map_err(|_| ())?;
                    self.scalar(i32::from_le_bytes(data).into())?;
                }
                b'K' | b'M' => {
                    let value = self.uint(if opcode == b'K' { 1 } else { 2 })?;
                    self.scalar(value.into())?;
                }
                0x8a | 0x8b => {
                    let count = self.uint(if opcode == 0x8a { 1 } else { 4 })?;
                    if count > 2048 {
                        return Err(());
                    }
                    self.budget.spend(count.checked_mul(8).ok_or(())?)?;
                    let value = BigInt::from_signed_bytes_le(self.read(count)?);
                    self.int(value)?;
                }
                b'F' | b'G' => {
                    let value = if opcode == b'F' {
                        self.text_line()?.parse::<f64>().map_err(|_| ())?
                    } else {
                        f64::from_be_bytes(self.read(8)?.try_into().map_err(|_| ())?)
                    };
                    self.scalar(serde_json::Number::from_f64(value).map(Value::Number).unwrap_or(Value::Null))?;
                }
                b'X' | 0x8c | 0x8d | b'T' | b'U' | b'B' | b'C' | 0x8e | 0x96 => {
                    let width = match opcode {
                        0x8c | b'U' | b'C' => 1,
                        0x8d | 0x8e | 0x96 => 8,
                        _ => 4,
                    };
                    let count = self.uint(width)?;
                    self.data(count, matches!(opcode, b'B' | b'C' | 0x8e | 0x96), matches!(opcode, b'T' | b'U'))?;
                }
                b'V' | b'S' => {
                    let mut line = self.line()?;
                    if opcode == b'S' {
                        if line.len() < 2 || !matches!(line[0], b'\'' | b'"') || line.last() != line.first() {
                            return Err(());
                        }
                        line = line[1..line.len() - 1].to_vec();
                    }
                    self.scalar(Value::String(decode_escapes(&line, opcode == b'V')?))?;
                }
                b']' => self.emit(Node::List(Vec::new()))?,
                b')' => self.emit(Node::Tuple(Vec::new()))?,
                0x8f => self.emit(Node::Set(Vec::new()))?,
                b'}' => self.emit(Node::Dict(Vec::new()))?,
                b'(' => {
                    if self.marks.len() >= MAX_DEPTH {
                        return Err(());
                    }
                    self.budget.spend(8)?;
                    self.marks.push(self.stack.len());
                }
                b'0' => {
                    self.pop()?;
                }
                b'1' => {
                    self.marked()?;
                }
                b'2' => {
                    let id = self.peek()?;
                    self.push(id)?;
                }
                b'l' | b't' | 0x91 => {
                    let items = self.marked()?;
                    self.emit(match opcode {
                        b'l' => Node::List(items),
                        b't' => Node::Tuple(items),
                        _ => Node::FrozenSet(items),
                    })?;
                }
                b'd' => {
                    let items = self.marked()?;
                    self.emit(Node::Dict(Self::pairs(items)?))?;
                }
                0x85..=0x87 => {
                    let mut items = Vec::new();
                    for _ in 0..opcode - 0x84 {
                        items.push(self.pop()?);
                    }
                    items.reverse();
                    self.emit(Node::Tuple(items))?;
                }
                b'a' | b'e' | 0x90 => {
                    let items = if opcode == b'a' { vec![self.pop()?] } else { self.marked()? };
                    let target = self.peek()?;
                    self.budget.spend(items.len().checked_mul(8).ok_or(())?)?;
                    match &mut self.arena[target] {
                        Node::List(list) if opcode != 0x90 => list.extend(items),
                        Node::Set(set) if opcode == 0x90 => set.extend(items),
                        _ => return Err(()),
                    }
                }
                b's' | b'u' => {
                    let pairs = if opcode == b's' {
                        let value = self.pop()?;
                        let key = self.pop()?;
                        vec![(key, value)]
                    } else {
                        Self::pairs(self.marked()?)?
                    };
                    let target = self.peek()?;
                    self.budget.spend(pairs.len().checked_mul(16).ok_or(())?)?;
                    match &mut self.arena[target] {
                        Node::Dict(dict) => dict.extend(pairs),
                        _ => return Err(()),
                    }
                }
                b'c' => {
                    let module = self.text_line()?;
                    let name = self.text_line()?;
                    self.emit(Node::Global(format!("{module}.{name}")))?;
                }
                0x93 => {
                    let name = self.pop()?;
                    let module = self.pop()?;
                    let name = self.string(name)?;
                    let module = self.string(module)?;
                    self.emit(Node::Global(format!("{module}.{name}")))?;
                }
                b'R' | 0x81 | 0x92 => {
                    let state = if opcode == 0x92 { Some(self.pop()?) } else { None };
                    let args = self.pop()?;
                    let class = self.pop()?;
                    let name = match &self.arena[class] {
                        Node::Global(name) => {
                            self.budget.spend(name.len())?;
                            name.clone()
                        }
                        Node::Instance { .. } | Node::Dict(_) => "[object Object]".to_owned(),
                        _ => return Err(()),
                    };
                    if !matches!(self.arena[args], Node::Tuple(_)) {
                        return Err(());
                    }
                    let node = if opcode == b'R' {
                        self.reduce(name, args)?
                    } else {
                        Node::Instance { class: name, args, state, show_state: true }
                    };
                    self.emit(node)?;
                }
                b'b' => {
                    let state = self.pop()?;
                    let target = self.peek()?;
                    match &mut self.arena[target] {
                        Node::Instance { state: value, show_state, .. } => {
                            *value = Some(state);
                            *show_state = true;
                        }
                        Node::Dict(_) => {
                            let items = match &self.arena[state] {
                                Node::Dict(items) => {
                                    self.budget.spend(items.len().checked_mul(16).ok_or(())?)?;
                                    items.clone()
                                }
                                _ => return Err(()),
                            };
                            if let Node::Dict(target) = &mut self.arena[target] {
                                target.extend(items);
                            }
                        }
                        _ => return Err(()),
                    }
                }
                b'i' | b'o' => {
                    let class = if opcode == b'i' {
                        Some(format!("{}.{}", self.text_line()?, self.text_line()?))
                    } else {
                        None
                    };
                    let mut items = self.marked()?;
                    let class = match class {
                        Some(name) => name,
                        None => {
                            if items.is_empty() {
                                return Err(());
                            }
                            let id = items.remove(0);
                            match &self.arena[id] {
                                Node::Global(name) => {
                                    self.budget.spend(name.len())?;
                                    name.clone()
                                }
                                _ => return Err(()),
                            }
                        }
                    };
                    let args = self.add(Node::Tuple(items))?;
                    self.emit(Node::Instance { class, args, state: None, show_state: true })?;
                }
                b'p' | b'q' | b'r' | 0x94 => {
                    let index = match opcode {
                        b'p' => self.text_line()?.parse().map_err(|_| ())?,
                        b'q' => self.uint(1)?,
                        b'r' => self.uint(4)?,
                        _ => self.memo.len(),
                    };
                    let id = self.peek()?;
                    self.budget.spend(32)?;
                    self.memo.insert(index, id);
                }
                b'g' | b'h' | b'j' => {
                    let index = match opcode {
                        b'g' => self.text_line()?.parse().map_err(|_| ())?,
                        b'h' => self.uint(1)?,
                        _ => self.uint(4)?,
                    };
                    let id = self.memo.get(&index).copied().ok_or(())?;
                    self.push(id)?;
                }
                _ => return Err(()),
            }
        }
    }
    fn string(&mut self, id: Id) -> Result<String> {
        match &self.arena[id] {
            Node::Scalar(Value::String(text)) => {
                self.budget.spend(text.len())?;
                Ok(text.clone())
            }
            _ => Err(()),
        }
    }
    fn payload(&mut self, id: Id) -> Result<Vec<u8>> {
        match &self.arena[id] {
            Node::Bytes(data) => {
                self.budget.spend(data.len())?;
                Ok(data.clone())
            }
            Node::Scalar(Value::String(text)) => {
                self.budget.spend(text.len())?;
                text.chars().map(|ch| u8::try_from(ch as u32).map_err(|_| ())).collect()
            }
            _ => Err(()),
        }
    }
    fn reduce(&mut self, class: String, args: Id) -> Result<Node> {
        let items = match &self.arena[args] {
            Node::Tuple(items) => {
                self.budget.spend(items.len() * 8)?;
                items.clone()
            }
            _ => return Err(()),
        };
        match class.as_str() {
            "_codecs.encode" if items.len() == 2 && self.string(items[1]).ok().as_deref() == Some("latin1") => {
                Ok(Node::Bytes(self.payload(items[0])?))
            }
            "builtins.bytes" | "__builtin__.bytes" | "builtins.bytearray" | "__builtin__.bytearray"
                if items.len() <= 1 =>
            {
                Ok(Node::Bytes(if let Some(id) = items.first() { self.payload(*id)? } else { Vec::new() }))
            }
            "builtins.set" | "__builtin__.set" | "builtins.frozenset" | "__builtin__.frozenset" if items.len() == 1 => {
                match &self.arena[items[0]] {
                    Node::List(values) | Node::Tuple(values) | Node::Set(values) | Node::FrozenSet(values) => {
                        self.budget.spend(values.len() * 8)?;
                        Ok(if class.ends_with(".frozenset") {
                            Node::FrozenSet(values.clone())
                        } else {
                            Node::Set(values.clone())
                        })
                    }
                    _ => Err(()),
                }
            }
            "copy_reg._reconstructor" | "copyreg._reconstructor" if !items.is_empty() => {
                let name = match &self.arena[items[0]] {
                    Node::Global(name) => {
                        self.budget.spend(name.len())?;
                        name.clone()
                    }
                    _ => return Err(()),
                };
                let empty = self.add(Node::Tuple(Vec::new()))?;
                Ok(Node::Instance { class: name, args: empty, state: None, show_state: true })
            }
            "datetime.datetime" | "datetime.date" | "datetime.time" => {
                let text = self.datetime(&class, &items)?;
                Ok(Node::Scalar(Value::String(text)))
            }
            _ => Ok(Node::Instance { class, args, state: None, show_state: false }),
        }
    }
    fn datetime(&mut self, class: &str, args: &[Id]) -> Result<String> {
        let packed = args
            .first()
            .is_some_and(|first| matches!(self.arena[*first], Node::Bytes(_) | Node::Scalar(Value::String(_))));
        let maximum = if packed {
            1
        } else {
            match class {
                "datetime.date" => 3,
                "datetime.datetime" => 7,
                _ => 4,
            }
        };
        // Only a null timezone is representable without losing information.
        let args = if class != "datetime.date"
            && args.len() == maximum + 1
            && matches!(self.arena[args[maximum]], Node::Scalar(Value::Null))
        {
            &args[..maximum]
        } else {
            args
        };
        let minimum = if packed {
            1
        } else if class == "datetime.time" {
            0
        } else {
            3
        };
        if args.len() < minimum || args.len() > maximum {
            return Err(());
        }
        let mut values = Vec::new();
        if let Some(first) = args.first() {
            if matches!(self.arena[*first], Node::Bytes(_) | Node::Scalar(Value::String(_))) {
                let bytes = self.payload(*first)?;
                match class {
                    "datetime.datetime" if bytes.len() == 10 => {
                        values = vec![
                            u32::from(bytes[0]) * 256 + u32::from(bytes[1]),
                            u32::from(bytes[2] & 0x7f),
                            u32::from(bytes[3]),
                            u32::from(bytes[4]),
                            u32::from(bytes[5]),
                            u32::from(bytes[6]),
                            u32::from(bytes[7]) * 65536 + u32::from(bytes[8]) * 256 + u32::from(bytes[9]),
                        ]
                    }
                    "datetime.date" if bytes.len() == 4 => {
                        values = vec![
                            u32::from(bytes[0]) * 256 + u32::from(bytes[1]),
                            u32::from(bytes[2]),
                            u32::from(bytes[3]),
                        ]
                    }
                    "datetime.time" if bytes.len() == 6 => {
                        values = vec![
                            u32::from(bytes[0] & 0x7f),
                            u32::from(bytes[1]),
                            u32::from(bytes[2]),
                            u32::from(bytes[3]) * 65536 + u32::from(bytes[4]) * 256 + u32::from(bytes[5]),
                        ]
                    }
                    _ => return Err(()),
                }
            } else {
                for id in args {
                    match &self.arena[*id] {
                        Node::Scalar(value) => values.push(u32::try_from(value.as_u64().ok_or(())?).map_err(|_| ())?),
                        _ => return Err(()),
                    }
                }
            }
        }
        let date = class != "datetime.time";
        let time = class != "datetime.date";
        if values.len() < if date { 3 } else { 0 } {
            return Err(());
        }
        let mut output = String::new();
        if date {
            if !(1..=9999).contains(&values[0]) || !(1..=12).contains(&values[1]) {
                return Err(());
            }
            let leap = values[0] % 4 == 0 && (values[0] % 100 != 0 || values[0] % 400 == 0);
            let days = match values[1] {
                2 => {
                    if leap {
                        29
                    } else {
                        28
                    }
                }
                4 | 6 | 9 | 11 => 30,
                _ => 31,
            };
            if !(1..=days).contains(&values[2]) {
                return Err(());
            }
            output = format!("{:04}-{:02}-{:02}", values[0], values[1], values[2]);
        }
        if time {
            let offset = if date { 3 } else { 0 };
            let hour = *values.get(offset).unwrap_or(&0);
            let minute = *values.get(offset + 1).unwrap_or(&0);
            let second = *values.get(offset + 2).unwrap_or(&0);
            let micro = *values.get(offset + 3).unwrap_or(&0);
            if hour > 23 || minute > 59 || second > 59 || micro > 999999 {
                return Err(());
            }
            if date {
                output.push('T');
            }
            output.push_str(&format!("{hour:02}:{minute:02}:{second:02}"));
            if micro != 0 {
                output.push_str(&format!(".{micro:06}"));
            }
        }
        Ok(output)
    }
    fn normalize(
        &mut self,
        id: Id,
        depth: usize,
        active: &mut HashSet<Id>,
        seen_dicts: &mut HashSet<Id>,
    ) -> Result<Value> {
        self.budget.node(depth)?;
        if !active.insert(id) {
            return Ok(serde_json::json!({"$ref": true}));
        }
        // Move out temporarily so recursive visits cannot borrow mutable arena data.
        let node = std::mem::replace(&mut self.arena[id], Node::Scalar(Value::Null));
        let result = match &node {
            Node::Scalar(value) => {
                self.budget.spend(value.as_str().map_or(0, str::len))?;
                value.clone()
            }
            Node::Bytes(bytes) => {
                self.budget.spend(bytes.len().checked_mul(2).ok_or(())?)?;
                match std::str::from_utf8(bytes) {
                    Ok(text) => Value::String(text.strip_prefix('\u{feff}').unwrap_or(text).to_owned()),
                    Err(_) => serde_json::json!({"$bytes":base64::engine::general_purpose::STANDARD.encode(bytes)}),
                }
            }
            Node::Global(name) => {
                self.budget.spend(name.len())?;
                serde_json::json!({"$class":name})
            }
            Node::List(items) | Node::Tuple(items) | Node::Set(items) | Node::FrozenSet(items) => {
                self.budget.spend(items.len().checked_mul(8).ok_or(())?)?;
                let mut output = Vec::with_capacity(items.len());
                for item in items {
                    output.push(self.normalize(*item, depth + 1, active, seen_dicts)?);
                }
                Value::Array(output)
            }
            Node::Dict(items) => {
                if !seen_dicts.insert(id) {
                    serde_json::json!({"$ref":true})
                } else {
                    // Resolve overwrites before visiting values: superseded objects
                    // must not become visible to shared-reference tracking.
                    let mut entries = Vec::new();
                    let mut positions = HashMap::new();
                    for (key, value) in items {
                        let key = self.normalize(*key, depth + 1, active, seen_dicts)?;
                        let key = match key {
                            Value::String(text) => text,
                            other => key_json_with_budget(&other, &mut self.budget)?,
                        };
                        if let Some(index) = positions.get(&key).copied() {
                            let entry: &mut (String, Id) = &mut entries[index];
                            entry.1 = *value;
                        } else {
                            self.budget.spend(key.len() + 64)?;
                            positions.insert(key.clone(), entries.len());
                            entries.push((key, *value));
                        }
                    }
                    let mut output = Map::new();
                    for (key, value) in entries {
                        output.insert(key, self.normalize(value, depth + 1, active, seen_dicts)?);
                    }
                    Value::Object(output)
                }
            }
            Node::Instance { class, args, state, show_state } => {
                if class == "uuid.UUID" && state.is_some() {
                    let state_id = state.ok_or(())?;
                    self.normalize_uuid(state_id, depth, active, seen_dicts)?
                } else {
                    self.budget.spend(class.len())?;
                    let mut object = Map::new();
                    object.insert("$class".into(), class.clone().into());
                    object.insert("$args".into(), self.normalize(*args, depth + 1, active, seen_dicts)?);
                    if *show_state {
                        object.insert(
                            "$state".into(),
                            match state {
                                Some(state) => self.normalize(*state, depth + 1, active, seen_dicts)?,
                                None => Value::Null,
                            },
                        );
                    }
                    Value::Object(object)
                }
            }
        };
        self.arena[id] = node;
        active.remove(&id);
        Ok(result)
    }
    fn normalize_uuid(
        &mut self,
        state: Id,
        depth: usize,
        active: &mut HashSet<Id>,
        seen: &mut HashSet<Id>,
    ) -> Result<Value> {
        let value = self.normalize(state, depth + 1, active, seen)?;
        let text = if let Some(integer) = value.get("int") {
            let integer = match integer {
                Value::String(text) => {
                    if text.len() > 4096 {
                        return Err(());
                    }
                    self.budget.spend(text.len().checked_mul(8).ok_or(())?)?;
                    text.clone()
                }
                other => {
                    self.budget.spend(32)?;
                    other.to_string()
                }
            };
            let integer: BigInt = integer.parse().map_err(|_| ())?;
            if integer < BigInt::from(0) || integer >= (BigInt::from(1) << 128) {
                return Err(());
            }
            format!("{integer:032x}")
        } else if let Some(hex) = value.get("hex").and_then(Value::as_str) {
            self.budget.spend(hex.len())?;
            hex.replace('-', "")
        } else {
            return Ok(serde_json::json!({"$class":"uuid.UUID","$state":value}));
        };
        if text.len() != 32 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(());
        }
        Ok(format!("{}-{}-{}-{}-{}", &text[..8], &text[8..12], &text[12..16], &text[16..20], &text[20..]).into())
    }
}

fn decode_escapes(bytes: &[u8], unicode: bool) -> Result<String> {
    let mut output = String::new();
    let mut pos = 0;
    while pos < bytes.len() {
        let byte = bytes[pos];
        pos += 1;
        if byte != b'\\' {
            output.push(char::from(byte));
            continue;
        }
        let escape = *bytes.get(pos).ok_or(())?;
        pos += 1;
        let digits = match escape {
            b'u' if unicode => 4,
            b'U' if unicode => 8,
            b'x' if !unicode => 2,
            _ => 0,
        };
        if digits > 0 {
            let end = pos.checked_add(digits).ok_or(())?;
            let hex = std::str::from_utf8(bytes.get(pos..end).ok_or(())?).map_err(|_| ())?;
            let code = u32::from_str_radix(hex, 16).map_err(|_| ())?;
            output.push(char::from_u32(code).ok_or(())?);
            pos = end;
        } else if unicode {
            output.push('\\');
            output.push(char::from(escape));
        } else {
            let decoded = match escape {
                b'n' => '\n',
                b'r' => '\r',
                b't' => '\t',
                b'b' => '\x08',
                b'f' => '\x0c',
                b'a' => '\x07',
                b'v' => '\x0b',
                b'\\' => '\\',
                b'\'' => '\'',
                b'"' => '"',
                b'0'..=b'7' => {
                    let mut value = u32::from(escape - b'0');
                    for _ in 0..2 {
                        if let Some(b'0'..=b'7') = bytes.get(pos) {
                            value = value * 8 + u32::from(bytes[pos] - b'0');
                            pos += 1;
                        } else {
                            break;
                        }
                    }
                    char::from_u32(value).ok_or(())?
                }
                other => {
                    output.push('\\');
                    char::from(other)
                }
            };
            output.push(decoded);
        }
    }
    Ok(output)
}
fn key_json_with_budget(value: &Value, budget: &mut DecodeBudget<'_>) -> Result<String> {
    struct BudgetWriter<'a, 'b> {
        bytes: Vec<u8>,
        budget: &'a mut DecodeBudget<'b>,
    }
    impl std::io::Write for BudgetWriter<'_, '_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.budget.spend(bytes.len()).map_err(|_| std::io::Error::other("pickle key budget exhausted"))?;
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = BudgetWriter { bytes: Vec::new(), budget };
    serde_json::to_writer(&mut writer, value).map_err(|_| ())?;
    String::from_utf8(writer.bytes).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    fn decode(bytes: &[u8]) -> Option<Value> {
        decode_pickle_with_budget(bytes, &mut (4 * 1024 * 1024))
    }
    #[test]
    fn python_generated_protocols_zero_through_five() {
        let fixtures: Value = serde_json::from_str(include_str!("../tests/fixtures/redis_pickle_python.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let bytes = base64::engine::general_purpose::STANDARD.decode(fixture["pickle"].as_str().unwrap()).unwrap();
            assert_eq!(decode(&bytes), Some(fixture["expected"].clone()), "{}", fixture["name"]);
        }
    }
    #[test]
    fn arbitrary_callables_are_inert_data() {
        assert_eq!(
            decode(b"cbuiltins\neval\n(V1+1\ntR."),
            Some(serde_json::json!({"$class":"builtins.eval","$args":["1+1"]}))
        );
        assert_eq!(
            decode(b"cos\nsystem\n(Vecho unsafe\ntR."),
            Some(serde_json::json!({"$class":"os.system","$args":["echo unsafe"]}))
        );
    }
    #[test]
    fn cycles_and_shared_references_are_bounded() {
        assert_eq!(decode(b"\x80\x04]\x94h\x00a."), Some(serde_json::json!([{"$ref":true}])));
        let mut amplified = b"]q\x00".to_vec();
        for _ in 0..30 {
            amplified.extend_from_slice(b"0(h\x00h\x00lq\x00");
        }
        amplified.push(b'.');
        assert!(decode(&amplified).is_none());
    }
    #[test]
    fn desktop_celery_fixtures_match() {
        let expected = serde_json::json!({"status":"SUCCESS","result":{"task":"add","value":3},"traceback":null,"children":[],"date_done":"2024-06-24T12:00:00"});
        for fixture in ["gASViwAAAAAAAAB9lCiMBnN0YXR1c5SMB1NVQ0NFU1OUjAZyZXN1bHSUfZQojAR0YXNrlIwDYWRklIwFdmFsdWWUSwN1jAl0cmFjZWJhY2uUTowIY2hpbGRyZW6UXZSMCWRhdGVfZG9uZZSMCGRhdGV0aW1llIwIZGF0ZXRpbWWUk5RDCgfoBhgMAAAAAACUhZRSlHUu", "gAJ9cQAoWAYAAABzdGF0dXNxAVgHAAAAU1VDQ0VTU3ECWAYAAAByZXN1bHRxA31xBChYBAAAAHRhc2txBVgDAAAAYWRkcQZYBQAAAHZhbHVlcQdLA3VYCQAAAHRyYWNlYmFja3EITlgIAAAAY2hpbGRyZW5xCV1xClgJAAAAZGF0ZV9kb25lcQtjZGF0ZXRpbWUKZGF0ZXRpbWUKcQxjX2NvZGVjcwplbmNvZGUKcQ1YCwAAAAfDqAYYDAAAAAAAcQ5YBgAAAGxhdGluMXEPhnEQUnERhXESUnETdS4="] {
            let bytes = base64::engine::general_purpose::STANDARD.decode(fixture).unwrap();
            assert_eq!(decode(&bytes), Some(expected.clone()));
        }
    }
    #[test]
    fn inert_object_lifecycle_and_non_global_callable() {
        assert_eq!(
            decode(b"capp\nTask\n(Va\nt\x81}Vstate\nK\x03sb."),
            Some(serde_json::json!({"$class":"app.Task","$args":["a"],"$state":{"state":3}}))
        );
        assert_eq!(decode(b"capp\nFactory\n)R)R."), Some(serde_json::json!({"$class":"[object Object]","$args":[]})));
        assert_eq!(
            decode(b"capp\nTask\n)}Vkw\nK\x01s\x92."),
            Some(serde_json::json!({"$class":"app.Task","$args":[],"$state":{"kw":1}}))
        );
    }
    #[test]
    fn rejects_excessive_integer_conversion_work() {
        let mut bytes = vec![b'L'];
        bytes.extend(vec![b'9'; 5000]);
        bytes.extend_from_slice(b"L\n.");
        assert!(decode(&bytes).is_none());
    }
    #[test]
    fn truncated_real_pickles_and_random_bytes_do_not_panic() {
        let fixtures: Value = serde_json::from_str(include_str!("../tests/fixtures/redis_pickle_python.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let bytes = base64::engine::general_purpose::STANDARD.decode(fixture["pickle"].as_str().unwrap()).unwrap();
            for end in 0..bytes.len() {
                assert!(decode(&bytes[..end]).is_none());
            }
        }
        let mut seed = 0xcafef00du64;
        for length in 0..128 {
            for _ in 0..32 {
                let bytes: Vec<_> = (0..length)
                    .map(|_| {
                        seed ^= seed << 13;
                        seed ^= seed >> 7;
                        seed ^= seed << 17;
                        seed as u8
                    })
                    .collect();
                let _ = decode(&bytes);
            }
        }
    }
    #[test]
    fn memo_mutations_preserve_cycles_and_shared_dictionary_identity() {
        assert_eq!(decode(b"}q\x00Vself\nh\x00s."), Some(serde_json::json!({"self":{"$ref":true}})));
        assert_eq!(decode(b"(}q\x00h\x00l."), Some(serde_json::json!([{}, {"$ref":true}])));
        assert_eq!(decode(b"(iapp\nTask\n."), Some(serde_json::json!({"$class":"app.Task","$args":[],"$state":null})));
        assert_eq!(
            decode(b"(capp\nTask\nVo\no."),
            Some(serde_json::json!({"$class":"app.Task","$args":["o"],"$state":null}))
        );
    }
    #[test]
    fn sequence_mutations_require_the_correct_python_container() {
        for bytes in [
            b"\x80\x04)K\x01a.".as_slice(),
            b"\x80\x04\x8fK\x01a.",
            b"\x80\x04](K\x01\x90.",
            b"\x80\x04)(K\x01e.",
            b"\x80\x04(K\x01\x91(K\x02\x90.",
        ] {
            assert!(decode(bytes).is_none(), "{bytes:?}");
        }
        assert_eq!(decode(b"\x80\x04\x8f(K\x01\x90."), Some(serde_json::json!([1])));
    }
    #[test]
    fn overwritten_dictionary_values_do_not_poison_reference_tracking() {
        let bytes = b"}q\x00Vx\n}q\x01sVx\nK\x01sVy\nh\x01s.";
        assert_eq!(decode(bytes), Some(serde_json::json!({"x":1,"y":{}})));
    }
    #[test]
    fn byte_text_decoder_strips_a_leading_utf8_bom() {
        assert_eq!(decode(b"\x80\x04C\x04\xef\xbb\xbfx."), Some(serde_json::json!("x")));
        assert_eq!(decode(b"\x80\x04\x8c\x04\xef\xbb\xbfx."), Some(serde_json::json!("x")));
    }
    #[test]
    fn json_dictionary_keys_charge_escaped_output_before_allocation() {
        let mut remaining = 64;
        let mut budget = DecodeBudget::new(&mut remaining);
        assert!(key_json_with_budget(&serde_json::json!(["\0".repeat(1000)]), &mut budget).is_err());
        let mut bytes = b"\x80\x04}\x94(X\xa0\x86\x01\x00".to_vec();
        bytes.extend(vec![0; 100_000]);
        bytes.extend_from_slice(b"\x95A\x00\x00\x00\x00\x00\x00\x00\x94");
        for _ in 0..29 {
            bytes.extend_from_slice(b"h\x01");
        }
        bytes.extend_from_slice(b"t\x94K\x00s.");
        assert_eq!(bytes.len(), 100_084);
        assert!(decode(&bytes).is_none());
        assert_eq!(
            decode(b"}K\x01Vone\ns(I01\nK\x02tVtuple\ns."),
            Some(serde_json::json!({"1":"one","[true,2]":"tuple"}))
        );
    }
    #[test]
    fn datetime_validates_calendar_arity_and_timezone_without_discarding_data() {
        assert_eq!(decode(b"cdatetime\ndate\n(M\xe8\x07K\x02K\x1dtR."), Some(serde_json::json!("2024-02-29")));
        for bytes in [
            b"cdatetime\ndate\n(M\xe8\x07K\x02K\x1ftR.".as_slice(),
            b"cdatetime\ndate\n(M\xe7\x07K\x02K\x1dtR.",
            b"cdatetime\ndatetime\n(K\x01K\x02K\x03K\x04K\x05K\x06K\x07K\x08tR.",
            b"cdatetime\ndate\n(M\xe8\x07K\x02K\x01K\x00tR.",
            b"cdatetime\ndatetime\n(C\x0a\x07\xe8\x02\x1d\x00\x00\x00\x00\x00\x00cdatetime\ntimezone\ntR.",
            b"cdatetime\ntime\n(C\x06\x0c\x00\x00\x00\x00\x00K\x01tR.",
        ] {
            assert!(decode(bytes).is_none(), "{bytes:?}");
        }
        assert_eq!(decode(b"cdatetime\ntime\n)R."), Some(serde_json::json!("00:00:00")));
    }
    #[test]
    fn malformed_and_out_of_budget_inputs_fail_closed() {
        for bytes in [
            b"N".as_slice(),
            b"N.x",
            b"(N.",
            b"NN.",
            b"h\x00.",
            b"\x80\x06N.",
            b"\x80\x04\x95\x02\x00\x00\x00\x00\x00\x00\x00N.",
            b"\x80\x04\x95\x01\x00\x00\x00\x00\x00\x00\x00K\x01.",
            b"\x80\x04\x95\x03\x00\x00\x00\x00\x00\x00\x00N.",
        ] {
            if bytes == b"\x80\x04\x95\x02\x00\x00\x00\x00\x00\x00\x00N." {
                assert_eq!(decode(bytes), Some(Value::Null));
            } else {
                assert!(decode(bytes).is_none(), "{bytes:?}");
            }
        }
        assert!(decode_pickle_with_budget(b"N.", &mut 1).is_none());
        assert!(decode(&vec![b'N'; 1024 * 1024 + 1]).is_none());
    }
}
