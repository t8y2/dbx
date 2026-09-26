use base64::Engine;
use mongodb::bson::{doc, Bson, Document};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionMetadata {
    #[serde(default)]
    pub options: Document,
    #[serde(default)]
    pub indexes: Vec<Document>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(default)]
    pub collection_name: String,
    #[serde(default, rename = "type")]
    pub kind: String,
}

impl CollectionMetadata {
    pub fn empty(name: &str) -> Self {
        Self {
            options: Document::new(),
            indexes: Vec::new(),
            uuid: None,
            collection_name: name.into(),
            kind: "collection".into(),
        }
    }

    pub fn from_json(json: &str, name: &str) -> Result<Self, String> {
        let value = serde_json::from_str(json).map_err(|e| format!("Invalid metadata for {name}: {e}"))?;
        let document = crate::db::mongo_driver::json_object_to_document_extended_json(&value)?;
        let mut metadata: Self =
            mongodb::bson::from_document(document).map_err(|e| format!("Invalid metadata for {name}: {e}"))?;
        if metadata.collection_name.is_empty() {
            metadata.collection_name = name.into();
        }
        if metadata.kind.is_empty() {
            metadata.kind = if metadata.options.contains_key("viewOn") { "view" } else { "collection" }.into();
        }
        metadata.validate()?;
        Ok(metadata)
    }

    pub fn to_json(&self) -> Result<String, String> {
        let document = mongodb::bson::to_document(self).map_err(|e| e.to_string())?;
        let json = crate::db::mongo_driver::document_to_canonical_extended_json(&document).to_string();
        if json.len() > super::archive::MAX_DOCUMENT {
            return Err("Collection metadata exceeds 16 MiB".into());
        }
        Ok(json)
    }

    pub fn is_view(&self) -> bool {
        self.kind == "view"
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_collection(&self.collection_name)?;
        let parsed_options: mongodb::options::CreateCollectionOptions =
            mongodb::bson::from_document(self.options.clone())
                .map_err(|e| format!("Invalid collection options for {}: {e}", self.collection_name))?;
        let known_options = mongodb::bson::to_document(&parsed_options).map_err(|e| e.to_string())?;
        for key in self.options.keys() {
            if !known_options.contains_key(key) && key != "autoIndexId" && key != "recordIdsReplicated" {
                return Err(format!("Unsupported collection option for {}: {key}", self.collection_name));
            }
        }
        if self.kind == "timeseries"
            || self.options.contains_key("timeseries")
            || self.options.contains_key("encryptedFields")
        {
            return Err(format!(
                "{}: time-series and encrypted collection dumps require server-specific restore support",
                self.collection_name
            ));
        }
        if self.kind != "collection" && self.kind != "view" {
            return Err(format!("Unsupported collection type: {}", self.kind));
        }
        if self.is_view() {
            self.options
                .get_str("viewOn")
                .map_err(|_| format!("{}: view metadata is missing viewOn", self.collection_name))?;
            if !self.indexes.is_empty() {
                return Err("View metadata cannot contain indexes".into());
            }
        }
        for index in &self.indexes {
            index.get_document("key").map_err(|_| "Index metadata is missing key".to_string())?;
            index.get_str("name").map_err(|_| "Index metadata is missing name".to_string())?;
        }
        Ok(())
    }

    pub fn create_command(&self, restore_options: bool) -> Document {
        let mut command = doc! { "create": &self.collection_name };
        if restore_options || self.is_view() {
            let mut options = self.options.clone();
            options.remove("uuid");
            options.remove("recordIdsReplicated");
            options.remove("autoIndexId");
            // Keep create as the first command key and never accept it from metadata.
            options.remove("create");
            command.extend(options);
        }
        command
    }

    pub fn restore_indexes(&self) -> Vec<Document> {
        self.indexes
            .iter()
            .filter(|index| {
                let key = index.get_document("key").expect("validated index");
                !(key.len() == 1
                    && matches!(key.get("_id"), Some(Bson::Int32(1) | Bson::Int64(1)) | Some(Bson::Double(1.0))))
            })
            .map(|index| {
                let mut index = index.clone();
                index.remove("ns");
                index.remove("v");
                index.remove("background");
                index
            })
            .collect()
    }
}

pub fn validate_database(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 63 || name.chars().any(|c| c.is_control() || " /\\.\"$*<>:|?".contains(c)) {
        return Err("Invalid MongoDB database name".into());
    }
    if matches!(name, "admin" | "config" | "local") {
        return Err(
            "Internal MongoDB databases and user/role migration are not supported by database dump/restore".into()
        );
    }
    Ok(())
}

pub fn validate_collection(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('\0')
        || name.contains('$')
        || (name.starts_with("system.") && name != "system.js")
    {
        return Err(format!("Unsupported MongoDB collection name: {name}"));
    }
    Ok(())
}

pub fn escaped_collection(name: &str) -> String {
    const ESCAPE: &percent_encoding::AsciiSet =
        &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');
    let mut escaped = percent_encoding::utf8_percent_encode(name, ESCAPE).to_string().replace("%20", "+");
    let stem = escaped.split('.').next().unwrap_or_default().to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        escaped = format!("%{:02X}{}", escaped.as_bytes()[0], &escaped[1..]);
    }
    if escaped.len() > 238 {
        let hash = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha1::digest(name.as_bytes()));
        escaped = format!("{}%24{hash}", &escaped[..208]);
    }
    escaped
}

pub fn unescape_collection(name: &str) -> Result<String, String> {
    let bytes = name.as_bytes();
    let mut position = 0;
    while position < bytes.len() {
        if bytes[position] == b'%' {
            if position + 2 >= bytes.len() || !bytes[position + 1..position + 3].iter().all(u8::is_ascii_hexdigit) {
                return Err("Invalid escaped collection filename".into());
            }
            position += 3;
        } else {
            position += 1;
        }
    }
    percent_encoding::percent_decode_str(&name.replace('+', " "))
        .decode_utf8()
        .map(|v| v.into_owned())
        .map_err(|e| e.to_string())
}
