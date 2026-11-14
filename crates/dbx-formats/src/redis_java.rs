//! Data-only Java Object Serialization decoding, matching the desktop Redis viewer.
//! No Java classes or deserialization callbacks are loaded or executed.
use std::collections::HashMap;

use serde_json::{json, Map, Value};

const MAX_INPUT: usize = 1024 * 1024;
const MAX_NODES: usize = 32_768;
const MAX_DEPTH: usize = 64;
const MAX_OUTPUT_WORK: usize = 4 * 1024 * 1024;
type Id = usize;
type Fields = Vec<(String, Id)>;
type Result<T> = std::result::Result<T, ()>;

#[derive(Clone)]
enum Node {
    Scalar(Value),
    Block(Vec<u8>),
    Enum(String, String),
    Object { class: Option<String>, fields: Fields, supers: Vec<(String, Fields)> },
    Array { class: Option<String>, values: Vec<Id> },
    Map(Vec<(Id, Id)>),
}

#[derive(Clone)]
struct Field {
    kind: u8,
    name: String,
    class_name: Option<String>,
}

#[derive(Clone, Default)]
struct Class {
    name: String,
    uid: String,
    flags: u8,
    fields: Vec<Field>,
    parent: Option<usize>,
    value: Option<Id>,
    weight: usize,
    complete: bool,
}

#[derive(Clone, Copy)]
enum Handle {
    Value(Id),
    Class(usize),
}

/// Returns `None` for unrecognized, unsupported, malformed or over-budget streams.
/// Object identity is represented by `$id`/`$ref`; Java longs remain decimal strings.
pub fn decode_java_serialized(bytes: &[u8]) -> Option<Value> {
    let mut remaining = MAX_OUTPUT_WORK;
    decode_java_serialized_with_budget(bytes, &mut remaining)
}

/// Shares decoding work across a compound Redis reply. Failed attempts consume
/// their work too; each value also retains its independent maximum allowance.
pub fn decode_java_serialized_with_budget(bytes: &[u8], remaining: &mut usize) -> Option<Value> {
    if bytes.len() > MAX_INPUT || !bytes.starts_with(&[0xac, 0xed, 0, 5]) {
        return None;
    }
    let allowance = (*remaining).min(MAX_OUTPUT_WORK);
    let mut parser =
        Parser { bytes, pos: 4, nodes: Vec::new(), classes: Vec::new(), handles: Vec::new(), work: allowance };
    let root = (|| {
        let mut roots = Vec::new();
        while parser.pos < bytes.len() {
            roots.push(parser.content(0)?);
        }
        match roots.len() {
            0 => Err(()),
            1 => Ok(roots[0]),
            _ => parser.array(None, roots),
        }
    })();
    *remaining -= allowance - parser.work;
    let root = root.ok()?;
    let mut normalizer = Normalizer { nodes: &parser.nodes, seen: HashMap::new(), work: parser.work };
    let result = normalizer.value(root, 0).ok();
    *remaining -= parser.work - normalizer.work;
    result
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    nodes: Vec<Node>,
    classes: Vec<Class>,
    handles: Vec<Handle>,
    work: usize,
}

impl Parser<'_> {
    fn spend(&mut self, count: usize) -> Result<()> {
        self.work = self.work.checked_sub(count).ok_or(())?;
        Ok(())
    }

    fn bytes(&mut self, count: usize) -> Result<&[u8]> {
        self.spend(count)?;
        let end = self.pos.checked_add(count).ok_or(())?;
        let bytes = self.bytes.get(self.pos..end).ok_or(())?;
        self.pos = end;
        Ok(bytes)
    }

    fn byte(&mut self) -> Result<u8> {
        Ok(self.bytes(1)?[0])
    }

    fn number<const N: usize>(&mut self) -> Result<[u8; N]> {
        self.bytes(N)?.try_into().map_err(|_| ())
    }

    fn node(&mut self, node: Node) -> Result<Id> {
        if self.nodes.len() >= MAX_NODES {
            return Err(());
        }
        let id = self.nodes.len();
        self.nodes.push(node);
        Ok(id)
    }

    fn scalar(&mut self, value: impl Into<Value>) -> Result<Id> {
        self.node(Node::Scalar(value.into()))
    }

    fn array(&mut self, class: Option<String>, values: Vec<Id>) -> Result<Id> {
        self.node(Node::Array { class, values })
    }

    fn handle(&mut self, handle: Handle) -> Result<()> {
        if self.handles.len() >= MAX_NODES {
            return Err(());
        }
        self.handles.push(handle);
        Ok(())
    }

    fn reference(&mut self) -> Result<Handle> {
        let wire = u32::from_be_bytes(self.number()?);
        let index = wire.checked_sub(0x7e0000).ok_or(())? as usize;
        self.handles.get(index).copied().ok_or(())
    }

    fn utf(&mut self) -> Result<String> {
        let length = u16::from_be_bytes(self.number()?) as usize;
        modified_utf8(self.bytes(length)?)
    }

    fn content(&mut self, depth: usize) -> Result<Id> {
        if depth >= MAX_DEPTH {
            return Err(());
        }
        match self.byte()? {
            0x70 => self.scalar(Value::Null),
            0x71 => match self.reference()? {
                Handle::Value(id) => Ok(id),
                Handle::Class(class) => self.class_value(class, depth + 1),
            },
            0x72 => {
                let class = self.new_class(depth + 1)?;
                self.class_value(class, depth + 1)
            }
            0x73 => self.object(depth + 1),
            0x74 | 0x7c => {
                let tag = self.bytes[self.pos - 1];
                let text = if tag == 0x74 {
                    self.utf()?
                } else {
                    let length = usize::try_from(u64::from_be_bytes(self.number()?)).map_err(|_| ())?;
                    modified_utf8(self.bytes(length)?)?
                };
                let id = self.scalar(text)?;
                self.handle(Handle::Value(id))?;
                Ok(id)
            }
            0x75 => {
                let class = self.class_desc(depth + 1)?.ok_or(())?;
                self.spend(self.classes[class].name.len())?;
                let name = self.classes[class].name.clone();
                if !name.starts_with('[') {
                    return Err(());
                }
                let id = self.scalar(Value::Null)?;
                self.handle(Handle::Value(id))?;
                let length = i32::from_be_bytes(self.number()?);
                let length = usize::try_from(length).map_err(|_| ())?;
                if length > MAX_NODES || length > self.bytes.len() - self.pos {
                    return Err(());
                }
                let mut values = Vec::new();
                for _ in 0..length {
                    values.push(self.field_value(*name.as_bytes().get(1).ok_or(())?, depth + 1)?);
                }
                self.nodes[id] = Node::Array { class: Some(name), values };
                Ok(id)
            }
            0x76 => {
                let class = self.class_desc(depth + 1)?.ok_or(())?;
                let value = self.class_value(class, depth + 1)?;
                self.handle(Handle::Value(value))?;
                Ok(value)
            }
            0x77 | 0x7a => {
                let tag = self.bytes[self.pos - 1];
                let length =
                    if tag == 0x77 { self.byte()? as usize } else { u32::from_be_bytes(self.number()?) as usize };
                let bytes = self.bytes(length)?.to_vec();
                self.node(Node::Block(bytes))
            }
            0x7e => {
                let class = self.class_desc(depth + 1)?.ok_or(())?;
                let id = self.scalar(Value::Null)?;
                self.handle(Handle::Value(id))?;
                let constant = self.content(depth + 1)?;
                let length = match &self.nodes[constant] {
                    Node::Scalar(Value::String(text)) => text.len(),
                    _ => return Err(()),
                };
                self.spend(self.classes[class].name.len() + length)?;
                let Node::Scalar(Value::String(text)) = &self.nodes[constant] else { return Err(()) };
                self.nodes[id] = Node::Enum(self.classes[class].name.clone(), text.clone());
                Ok(id)
            }
            _ => Err(()),
        }
    }

    fn class_desc(&mut self, depth: usize) -> Result<Option<usize>> {
        if depth >= MAX_DEPTH {
            return Err(());
        }
        match self.byte()? {
            0x70 => Ok(None),
            0x71 => match self.reference()? {
                Handle::Class(class) if self.classes[class].complete => Ok(Some(class)),
                _ => Err(()),
            },
            0x72 => Ok(Some(self.new_class(depth + 1)?)),
            _ => Err(()),
        }
    }

    fn new_class(&mut self, depth: usize) -> Result<usize> {
        if depth >= MAX_DEPTH || self.classes.len() >= MAX_NODES {
            return Err(());
        }
        let name = self.utf()?;
        let uid = hex(self.bytes(8)?);
        let id = self.classes.len();
        self.classes.push(Class { name, uid, ..Default::default() });
        self.handle(Handle::Class(id))?;
        let flags = self.byte()?;
        let count = u16::from_be_bytes(self.number()?);
        let mut fields = Vec::new();
        for _ in 0..count {
            let kind = self.byte()?;
            if !b"BCDFIJSZL[".contains(&kind) {
                return Err(());
            }
            let name = self.utf()?;
            self.spend(32 + name.len())?;
            let class_name = if kind == b'L' || kind == b'[' {
                let value = self.content(depth + 1)?;
                let length = match &self.nodes[value] {
                    Node::Scalar(Value::String(name)) => name.len(),
                    _ => return Err(()),
                };
                self.spend(length)?;
                let Node::Scalar(Value::String(name)) = &self.nodes[value] else { return Err(()) };
                Some(name.clone())
            } else {
                None
            };
            fields.push(Field { kind, name, class_name });
        }
        self.annotations(depth + 1)?;
        let parent = self.class_desc(depth + 1)?;
        let mut ancestry = vec![id];
        let mut cursor = parent;
        while let Some(index) = cursor {
            if ancestry.contains(&index) || ancestry.len() >= MAX_DEPTH {
                return Err(());
            }
            ancestry.push(index);
            cursor = self.classes[index].parent;
        }
        self.classes[id].weight = 64
            + self.classes[id].name.len()
            + fields.iter().map(|f| 32 + f.name.len() + f.class_name.as_ref().map_or(0, String::len)).sum::<usize>();
        self.classes[id].flags = flags;
        self.classes[id].fields = fields;
        self.classes[id].parent = parent;
        self.classes[id].complete = true;
        Ok(id)
    }

    fn annotations(&mut self, depth: usize) -> Result<Vec<Id>> {
        let mut values = Vec::new();
        while self.bytes.get(self.pos) != Some(&0x78) {
            values.push(self.content(depth + 1)?);
        }
        self.pos += 1;
        Ok(values)
    }

    fn object(&mut self, depth: usize) -> Result<Id> {
        let class = self.class_desc(depth + 1)?.ok_or(())?;
        let id = self.scalar(Value::Null)?;
        self.handle(Handle::Value(id))?;
        let mut chain = Vec::new();
        let mut cursor = Some(class);
        while let Some(index) = cursor {
            if chain.contains(&index) || chain.len() >= MAX_DEPTH {
                return Err(());
            }
            chain.push(index);
            cursor = self.classes[index].parent;
        }
        let mut fields = Vec::new();
        let mut supers = Vec::new();
        for &index in chain.iter().rev() {
            self.spend(self.classes[index].weight)?;
            let descriptor = self.classes[index].clone();
            let flags = descriptor.flags & 0x0f;
            let mut own = Vec::new();
            if flags == 2 || flags == 3 {
                for field in &descriptor.fields {
                    own.push((field.name.clone(), self.field_value(field.kind, depth + 1)?));
                }
            } else if flags != 12 {
                return Err(());
            }
            if flags == 3 || flags == 12 {
                let annotations = self.annotations(depth + 1)?;
                own.push(("@".into(), self.array(None, annotations.clone())?));
                if flags == 3 {
                    self.post_process(&descriptor, &mut own, &annotations)?;
                }
            }
            for (name, value) in &own {
                self.spend((fields.len() + 1) * name.len().max(1))?;
                insert(&mut fields, name.clone(), *value);
            }
            supers.push((descriptor.name, own));
        }
        self.nodes[id] = Node::Object { class: Some(self.classes[class].name.clone()), fields, supers };
        Ok(id)
    }

    fn field_value(&mut self, kind: u8, depth: usize) -> Result<Id> {
        match kind {
            b'B' => {
                let v = self.byte()? as i8;
                self.scalar(v)
            }
            b'C' => {
                let v = u16::from_be_bytes(self.number()?);
                self.scalar(String::from_utf16(&[v]).map_err(|_| ())?)
            }
            b'D' => {
                let v = f64::from_be_bytes(self.number()?);
                self.scalar(json!(v))
            }
            b'F' => {
                let v = f32::from_be_bytes(self.number()?);
                self.scalar(json!(v as f64))
            }
            b'I' => {
                let v = i32::from_be_bytes(self.number()?);
                self.scalar(v)
            }
            b'J' => {
                let v = i64::from_be_bytes(self.number()?);
                self.scalar(v.to_string())
            }
            b'S' => {
                let v = i16::from_be_bytes(self.number()?);
                self.scalar(v)
            }
            b'Z' => {
                let v = self.byte()? != 0;
                self.scalar(v)
            }
            b'L' | b'[' => self.content(depth + 1),
            _ => Err(()),
        }
    }

    fn post_process(&mut self, class: &Class, fields: &mut Fields, values: &[Id]) -> Result<()> {
        let key = (class.name.as_str(), class.uid.as_str());
        match key {
            ("java.util.ArrayList", "7881d21d99c7619d") | ("java.util.ArrayDeque", "207cda2e240da08b") => {
                fields.push(("list".into(), self.array(None, values.get(1..).unwrap_or_default().to_vec())?));
            }
            ("java.util.HashMap", "0507dac1c31660d1" | "0507b0c1331660d1")
            | ("java.util.Hashtable", "13bb0f25214ae4b8")
            | ("java.util.EnumMap", "065d7df7be907ca1") => {
                let enum_map = class.name == "java.util.EnumMap";
                let offset = if enum_map { 0 } else { 4 };
                let Some(Node::Block(header)) = values.first().map(|id| &self.nodes[*id]) else { return Ok(()) };
                let size = i32::from_be_bytes(header.get(offset..offset + 4).ok_or(())?.try_into().map_err(|_| ())?);
                let size = usize::try_from(size).map_err(|_| ())?;
                if size > values.len().saturating_sub(1) / 2 {
                    return Err(());
                }
                let mut entries = Vec::new();
                let mut obj = Vec::new();
                for index in 0..size {
                    let k = values[2 * index + 1];
                    let v = values[2 * index + 2];
                    self.spend((entries.len() + obj.len() + 1) * self.key_cost(k))?;
                    if let Some((_, old)) = entries.iter_mut().find(|(old, _)| self.same_key(*old, k)) {
                        *old = v;
                    } else {
                        entries.push((k, v));
                    }
                    let name = match &self.nodes[k] {
                        Node::Scalar(Value::String(name)) => Some(name.clone()),
                        Node::Enum(_, name) if enum_map => Some(name.clone()),
                        _ => None,
                    };
                    if let Some(name) = name {
                        insert(&mut obj, name, v);
                    }
                }
                fields.push(("map".into(), self.node(Node::Map(entries))?));
                fields.push(("obj".into(), self.node(Node::Object { class: None, fields: obj, supers: Vec::new() })?));
            }
            ("java.util.HashSet", "ba44859596b8b734") => {
                let Some(Node::Block(header)) = values.first().map(|id| &self.nodes[*id]) else { return Ok(()) };
                let size = i32::from_be_bytes(header.get(8..12).ok_or(())?.try_into().map_err(|_| ())?);
                if usize::try_from(size).ok() == Some(values.len() - 1) {
                    let mut unique = Vec::new();
                    for &value in &values[1..] {
                        self.spend(unique.len() * self.key_cost(value))?;
                        if !unique.iter().any(|old| self.same_key(*old, value)) {
                            unique.push(value);
                        }
                    }
                    fields.push(("set".into(), self.array(None, unique)?));
                }
            }
            _ => (),
        }
        Ok(())
    }

    fn key_cost(&self, id: Id) -> usize {
        match &self.nodes[id] {
            Node::Scalar(Value::String(text)) | Node::Enum(_, text) => text.len().max(1),
            _ => 32,
        }
    }

    fn same_key(&self, a: Id, b: Id) -> bool {
        a == b || matches!((&self.nodes[a], &self.nodes[b]), (Node::Scalar(a), Node::Scalar(b)) if a == b)
    }

    fn class_value(&mut self, index: usize, depth: usize) -> Result<Id> {
        if depth >= MAX_DEPTH || !self.classes[index].complete {
            return Err(());
        }
        if let Some(id) = self.classes[index].value {
            return Ok(id);
        }
        self.spend(self.classes[index].weight)?;
        let class = self.classes[index].clone();
        let id = self.scalar(Value::Null)?;
        self.classes[index].value = Some(id);
        let mut fields = vec![
            ("name".into(), self.scalar(class.name)?),
            ("serialVersionUID".into(), self.scalar(class.uid)?),
            ("flags".into(), self.scalar(class.flags)?),
            ("isEnum".into(), self.scalar(class.flags & 0x10 != 0)?),
        ];
        let mut field_values = Vec::new();
        for field in class.fields {
            let mut own = vec![
                ("type".into(), self.scalar((field.kind as char).to_string())?),
                ("name".into(), self.scalar(field.name)?),
            ];
            if let Some(name) = field.class_name {
                own.push(("className".into(), self.scalar(name)?));
            }
            field_values.push(self.node(Node::Object { class: None, fields: own, supers: Vec::new() })?);
        }
        fields.push(("fields".into(), self.array(None, field_values)?));
        let parent = match class.parent {
            Some(parent) => self.class_value(parent, depth + 1)?,
            None => self.scalar(Value::Null)?,
        };
        fields.push(("superClass".into(), parent));
        self.nodes[id] = Node::Object { class: None, fields, supers: Vec::new() };
        Ok(id)
    }
}

fn insert(fields: &mut Fields, name: String, value: Id) {
    if let Some((_, old)) = fields.iter_mut().find(|(key, _)| *key == name) {
        *old = value;
    } else {
        fields.push((name, value));
    }
}

struct Normalizer<'a> {
    nodes: &'a [Node],
    seen: HashMap<Id, String>,
    work: usize,
}

impl Normalizer<'_> {
    fn spend(&mut self, count: usize) -> Result<()> {
        self.work = self.work.checked_sub(count).ok_or(())?;
        Ok(())
    }

    fn fields(&mut self, fields: &Fields, depth: usize) -> Result<Map<String, Value>> {
        let mut out = Map::new();
        for (name, id) in fields {
            self.spend(name.len())?;
            out.insert(name.clone(), self.value(*id, depth + 1)?);
        }
        Ok(out)
    }

    fn value(&mut self, id: Id, depth: usize) -> Result<Value> {
        if depth >= MAX_DEPTH {
            return Err(());
        }
        self.spend(32)?;
        let node = &self.nodes[id];
        match node {
            Node::Scalar(value) => {
                if let Value::String(text) = value {
                    self.spend(text.len())?;
                }
                return Ok(value.clone());
            }
            Node::Block(bytes) => {
                self.spend(bytes.len() * 2)?;
                return Ok(json!({"$blockDataHex": hex(bytes)}));
            }
            Node::Enum(class, name) => {
                self.spend(class.len() + name.len())?;
                return Ok(json!({"$class":class,"$enum":name}));
            }
            _ => (),
        }
        if let Some(reference) = self.seen.get(&id) {
            return Ok(json!({"$ref":reference}));
        }
        let name = format!("#{}", self.seen.len() + 1);
        self.seen.insert(id, name.clone());
        let mut out = Map::new();
        out.insert("$id".into(), json!(name));
        match node {
            Node::Object { class, fields, supers } => {
                if let Some(class) = class {
                    self.spend(class.len())?;
                    out.insert("$class".into(), json!(class));
                }
                out.extend(self.fields(fields, depth + 1)?);
                if supers.len() > 1 {
                    let mut inherited = Map::new();
                    for (name, fields) in supers {
                        self.spend(name.len())?;
                        inherited.insert(name.clone(), self.fields(fields, depth + 1)?.into());
                    }
                    out.insert("$extends".into(), inherited.into());
                }
            }
            Node::Array { class, values } => {
                if let Some(class) = class {
                    self.spend(class.len())?;
                    out.insert("$class".into(), json!(class));
                }
                let values = values.iter().map(|id| self.value(*id, depth + 1)).collect::<Result<Vec<_>>>()?;
                out.insert("$values".into(), values.into());
            }
            Node::Map(entries) => {
                let entries = entries
                    .iter()
                    .map(|(k, v)| Ok(json!({"key":self.value(*k, depth + 1)?,"value":self.value(*v, depth + 1)?})))
                    .collect::<Result<Vec<_>>>()?;
                out.insert("$entries".into(), entries.into());
            }
            _ => return Err(()),
        }
        Ok(out.into())
    }
}

fn modified_utf8(bytes: &[u8]) -> Result<String> {
    let mut units = Vec::new();
    let mut pos = 0;
    while pos < bytes.len() {
        let a = bytes[pos];
        pos += 1;
        let unit = match a {
            1..=0x7f => a as u16,
            0xc0..=0xdf => {
                let b = *bytes.get(pos).ok_or(())?;
                pos += 1;
                if b & 0xc0 != 0x80 {
                    return Err(());
                }
                let unit = ((a as u16 & 0x1f) << 6) | (b as u16 & 0x3f);
                if unit < 0x80 && unit != 0 {
                    return Err(());
                }
                unit
            }
            0xe0..=0xef => {
                let b = *bytes.get(pos).ok_or(())?;
                let c = *bytes.get(pos + 1).ok_or(())?;
                pos += 2;
                if b & 0xc0 != 0x80 || c & 0xc0 != 0x80 {
                    return Err(());
                }
                let unit = ((a as u16 & 0xf) << 12) | ((b as u16 & 0x3f) << 6) | (c as u16 & 0x3f);
                if unit < 0x800 {
                    return Err(());
                }
                unit
            }
            _ => return Err(()),
        };
        units.push(unit);
    }
    String::from_utf16(&units).map_err(|_| ())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}
