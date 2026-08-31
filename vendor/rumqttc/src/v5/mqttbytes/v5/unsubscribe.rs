use super::*;
use bytes::{Buf, Bytes};

/// Unsubscribe packet
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Unsubscribe {
    pub pkid: u16,
    pub filters: Vec<String>,
    pub properties: Option<UnsubscribeProperties>,
}

impl Unsubscribe {
    pub fn new<S: Into<String>>(filter: S, properties: Option<UnsubscribeProperties>) -> Self {
        Self {
            filters: vec![filter.into()],
            properties,
            ..Default::default()
        }
    }

    pub fn size(&self) -> usize {
        let len = self.len();
        let remaining_len_size = len_len(len);

        1 + remaining_len_size + len
    }

    fn len(&self) -> usize {
        // Packet id + length of filters (unlike subscribe, this just a string.
        // Hence 2 is prefixed for len per filter)
        let mut len = 2 + self.filters.iter().fold(0, |s, t| 2 + s + t.len());

        if let Some(p) = &self.properties {
            let properties_len = p.len();
            let properties_len_len = len_len(properties_len);
            len += properties_len_len + properties_len;
        } else {
            // just 1 byte representing 0 len
            len += 1;
        }

        len
    }

    pub fn read(fixed_header: FixedHeader, mut bytes: Bytes) -> Result<Unsubscribe, Error> {
        let variable_header_index = fixed_header.fixed_header_len;
        bytes.advance(variable_header_index);

        let pkid = read_u16(&mut bytes)?;
        let properties = UnsubscribeProperties::read(&mut bytes)?;

        let mut filters = Vec::with_capacity(1);
        while bytes.has_remaining() {
            let filter = read_mqtt_string(&mut bytes)?;
            filters.push(filter);
        }

        let unsubscribe = Unsubscribe {
            pkid,
            filters,
            properties,
        };
        Ok(unsubscribe)
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<usize, Error> {
        buffer.put_u8(0xA2);

        // write remaining length
        let remaining_len = self.len();
        let remaining_len_bytes = write_remaining_length(buffer, remaining_len)?;

        // write packet id
        buffer.put_u16(self.pkid);

        if let Some(p) = &self.properties {
            p.write(buffer)?;
        } else {
            write_remaining_length(buffer, 0)?;
        }

        // write filters
        for filter in self.filters.iter() {
            write_mqtt_string(buffer, filter);
        }

        Ok(1 + remaining_len_bytes + remaining_len)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsubscribeProperties {
    pub user_properties: Vec<(String, String)>,
}

impl UnsubscribeProperties {
    fn len(&self) -> usize {
        let mut len = 0;

        for (key, value) in self.user_properties.iter() {
            len += 1 + 2 + key.len() + 2 + value.len();
        }

        len
    }

    pub fn read(bytes: &mut Bytes) -> Result<Option<UnsubscribeProperties>, Error> {
        let mut user_properties = Vec::new();

        let (properties_len_len, properties_len) = length(bytes.iter())?;
        bytes.advance(properties_len_len);

        if properties_len == 0 {
            return Ok(None);
        }

        let mut cursor = 0;
        // read until cursor reaches property length. properties_len = 0 will skip this loop
        while cursor < properties_len {
            let prop = read_u8(bytes)?;
            cursor += 1;

            match property(prop)? {
                PropertyType::UserProperty => {
                    let key = read_mqtt_string(bytes)?;
                    let value = read_mqtt_string(bytes)?;
                    cursor += 2 + key.len() + 2 + value.len();
                    user_properties.push((key, value));
                }
                _ => return Err(Error::InvalidPropertyType(prop)),
            }
        }

        Ok(Some(UnsubscribeProperties { user_properties }))
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<(), Error> {
        let len = self.len();
        write_remaining_length(buffer, len)?;

        for (key, value) in self.user_properties.iter() {
            buffer.put_u8(PropertyType::UserProperty as u8);
            write_mqtt_string(buffer, key);
            write_mqtt_string(buffer, value);
        }

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::super::test::{USER_PROP_KEY, USER_PROP_VAL};
    use super::*;
    use bytes::BytesMut;
    use pretty_assertions::assert_eq;

    #[test]
    fn length_calculation() {
        let mut dummy_bytes = BytesMut::new();
        // Use user_properties to pad the size to exceed ~128 bytes to make the
        // remaining_length field in the packet be 2 bytes long.
        let unsubscribe_props = UnsubscribeProperties {
            user_properties: vec![(USER_PROP_KEY.into(), USER_PROP_VAL.into())],
        };

        let unsubscribe_pkt = Unsubscribe::new("hello/world", Some(unsubscribe_props));

        let size_from_size = unsubscribe_pkt.size();
        let size_from_write = unsubscribe_pkt.write(&mut dummy_bytes).unwrap();
        let size_from_bytes = dummy_bytes.len();

        assert_eq!(size_from_write, size_from_bytes);
        assert_eq!(size_from_size, size_from_bytes);
    }
}
