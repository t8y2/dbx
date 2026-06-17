/// Shared WKB (Well-Known Binary) geometry parsing shared by PostgreSQL (EWKB)
/// and MySQL (standard WKB). Parses WKB bytes into WKT (Well-Known Text) strings.
///
/// Supports: POINT, LINESTRING, POLYGON, MULTIPOINT, MULTILINESTRING,
/// MULTIPOLYGON, GEOMETRYCOLLECTION, and their Z/M/ZM variants.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WkbDimensions {
    has_z: bool,
    has_m: bool,
}

impl WkbDimensions {
    fn suffix(self) -> &'static str {
        match (self.has_z, self.has_m) {
            (false, false) => "",
            (true, false) => " Z",
            (false, true) => " M",
            (true, true) => " ZM",
        }
    }

    fn coordinate_len(self) -> usize {
        2 + usize::from(self.has_z) + usize::from(self.has_m)
    }
}

#[derive(Debug, Clone, PartialEq)]
enum WkbGeometry {
    Point { dims: WkbDimensions, coords: Option<Vec<f64>> },
    LineString { dims: WkbDimensions, points: Vec<Vec<f64>> },
    Polygon { dims: WkbDimensions, rings: Vec<Vec<Vec<f64>>> },
    MultiPoint { dims: WkbDimensions, points: Vec<Option<Vec<f64>>> },
    MultiLineString { dims: WkbDimensions, lines: Vec<Vec<Vec<f64>>> },
    MultiPolygon { dims: WkbDimensions, polygons: Vec<Vec<Vec<Vec<f64>>>> },
    GeometryCollection { dims: WkbDimensions, geometries: Vec<WkbGeometry> },
}

impl WkbGeometry {
    fn to_wkt(&self) -> String {
        match self {
            Self::Point { dims, coords } => match coords {
                Some(coords) => format!("POINT{}({})", dims.suffix(), format_wkb_coordinate(coords)),
                None => format!("POINT{} EMPTY", dims.suffix()),
            },
            Self::LineString { dims, points } => {
                if points.is_empty() {
                    format!("LINESTRING{} EMPTY", dims.suffix())
                } else {
                    format!("LINESTRING{}({})", dims.suffix(), format_wkb_coordinate_sequence(points))
                }
            }
            Self::Polygon { dims, rings } => {
                if rings.is_empty() {
                    format!("POLYGON{} EMPTY", dims.suffix())
                } else {
                    format!(
                        "POLYGON{}({})",
                        dims.suffix(),
                        rings
                            .iter()
                            .map(|ring| format!("({})", format_wkb_coordinate_sequence(ring)))
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                }
            }
            Self::MultiPoint { dims, points } => {
                if points.is_empty() {
                    format!("MULTIPOINT{} EMPTY", dims.suffix())
                } else {
                    format!(
                        "MULTIPOINT{}({})",
                        dims.suffix(),
                        points
                            .iter()
                            .map(|point| match point {
                                Some(coords) => format!("({})", format_wkb_coordinate(coords)),
                                None => "EMPTY".to_string(),
                            })
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                }
            }
            Self::MultiLineString { dims, lines } => {
                if lines.is_empty() {
                    format!("MULTILINESTRING{} EMPTY", dims.suffix())
                } else {
                    format!(
                        "MULTILINESTRING{}({})",
                        dims.suffix(),
                        lines
                            .iter()
                            .map(|line| format!("({})", format_wkb_coordinate_sequence(line)))
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                }
            }
            Self::MultiPolygon { dims, polygons } => {
                if polygons.is_empty() {
                    format!("MULTIPOLYGON{} EMPTY", dims.suffix())
                } else {
                    format!(
                        "MULTIPOLYGON{}({})",
                        dims.suffix(),
                        polygons
                            .iter()
                            .map(|polygon| {
                                format!(
                                    "({})",
                                    polygon
                                        .iter()
                                        .map(|ring| format!("({})", format_wkb_coordinate_sequence(ring)))
                                        .collect::<Vec<_>>()
                                        .join(",")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                }
            }
            Self::GeometryCollection { dims, geometries } => {
                if geometries.is_empty() {
                    format!("GEOMETRYCOLLECTION{} EMPTY", dims.suffix())
                } else {
                    format!(
                        "GEOMETRYCOLLECTION{}({})",
                        dims.suffix(),
                        geometries.iter().map(WkbGeometry::to_wkt).collect::<Vec<_>>().join(",")
                    )
                }
            }
        }
    }
}

fn format_wkb_coordinate(coords: &[f64]) -> String {
    coords.iter().map(|value| value.to_string()).collect::<Vec<_>>().join(" ")
}

fn format_wkb_coordinate_sequence(points: &[Vec<f64>]) -> String {
    points.iter().map(|point| format_wkb_coordinate(point)).collect::<Vec<_>>().join(",")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WkbEndian {
    Big,
    Little,
}

struct WkbReader<'a> {
    raw: &'a [u8],
    pos: usize,
}

impl<'a> WkbReader<'a> {
    fn new(raw: &'a [u8]) -> Self {
        Self { raw, pos: 0 }
    }

    fn read_u8(&mut self) -> Option<u8> {
        let value = *self.raw.get(self.pos)?;
        self.pos += 1;
        Some(value)
    }

    fn read_array<const N: usize>(&mut self) -> Option<[u8; N]> {
        let end = self.pos.checked_add(N)?;
        let bytes: [u8; N] = self.raw.get(self.pos..end)?.try_into().ok()?;
        self.pos = end;
        Some(bytes)
    }

    fn read_u32(&mut self, endian: WkbEndian) -> Option<u32> {
        let bytes = self.read_array::<4>()?;
        Some(match endian {
            WkbEndian::Big => u32::from_be_bytes(bytes),
            WkbEndian::Little => u32::from_le_bytes(bytes),
        })
    }

    fn read_f64(&mut self, endian: WkbEndian) -> Option<f64> {
        let bytes = self.read_array::<8>()?;
        Some(match endian {
            WkbEndian::Big => f64::from_be_bytes(bytes),
            WkbEndian::Little => f64::from_le_bytes(bytes),
        })
    }
}

fn parse_wkb_dimensions(type_word: u32) -> (u32, WkbDimensions, bool) {
    let mut base_type = type_word & 0x1FFF_FFFF;
    let mut dims = WkbDimensions { has_z: (type_word & 0x8000_0000) != 0, has_m: (type_word & 0x4000_0000) != 0 };
    let has_srid = (type_word & 0x2000_0000) != 0;

    if base_type >= 3000 {
        dims.has_z = true;
        dims.has_m = true;
        base_type -= 3000;
    } else if base_type >= 2000 {
        dims.has_m = true;
        base_type -= 2000;
    } else if base_type >= 1000 {
        dims.has_z = true;
        base_type -= 1000;
    }

    (base_type, dims, has_srid)
}

fn read_wkb_point_coords(reader: &mut WkbReader<'_>, dims: WkbDimensions, allow_empty_point: bool) -> Option<Vec<f64>> {
    let endian = match reader.read_u8()? {
        0 => WkbEndian::Big,
        1 => WkbEndian::Little,
        _ => return None,
    };
    let type_word = reader.read_u32(endian)?;
    let (base_type, parsed_dims, has_srid) = parse_wkb_dimensions(type_word);
    if base_type != 1 || parsed_dims != dims {
        return None;
    }
    if has_srid {
        reader.read_u32(endian)?;
    }
    let coords = (0..parsed_dims.coordinate_len()).map(|_| reader.read_f64(endian)).collect::<Option<Vec<_>>>()?;
    if allow_empty_point && coords.iter().all(|value| value.is_nan()) {
        return None;
    }
    Some(coords)
}

fn parse_wkb_points(reader: &mut WkbReader<'_>, endian: WkbEndian, dims: WkbDimensions) -> Option<Vec<Vec<f64>>> {
    let count = usize::try_from(reader.read_u32(endian)?).ok()?;
    (0..count)
        .map(|_| (0..dims.coordinate_len()).map(|_| reader.read_f64(endian)).collect::<Option<Vec<_>>>())
        .collect::<Option<Vec<_>>>()
}

fn parse_wkb_geometry(reader: &mut WkbReader<'_>) -> Option<WkbGeometry> {
    let endian = match reader.read_u8()? {
        0 => WkbEndian::Big,
        1 => WkbEndian::Little,
        _ => return None,
    };
    let type_word = reader.read_u32(endian)?;
    let (base_type, dims, has_srid) = parse_wkb_dimensions(type_word);
    if has_srid {
        reader.read_u32(endian)?;
    }

    match base_type {
        1 => {
            let coords = (0..dims.coordinate_len()).map(|_| reader.read_f64(endian)).collect::<Option<Vec<_>>>()?;
            let coords = if coords.iter().all(|value| value.is_nan()) { None } else { Some(coords) };
            Some(WkbGeometry::Point { dims, coords })
        }
        2 => Some(WkbGeometry::LineString { dims, points: parse_wkb_points(reader, endian, dims)? }),
        3 => {
            let ring_count = usize::try_from(reader.read_u32(endian)?).ok()?;
            let rings = (0..ring_count).map(|_| parse_wkb_points(reader, endian, dims)).collect::<Option<Vec<_>>>()?;
            Some(WkbGeometry::Polygon { dims, rings })
        }
        4 => {
            let count = usize::try_from(reader.read_u32(endian)?).ok()?;
            let points =
                (0..count).map(|_| Some(read_wkb_point_coords(reader, dims, true))).collect::<Option<Vec<_>>>()?;
            Some(WkbGeometry::MultiPoint { dims, points })
        }
        5 => {
            let count = usize::try_from(reader.read_u32(endian)?).ok()?;
            let lines = (0..count)
                .map(|_| match parse_wkb_geometry(reader)? {
                    WkbGeometry::LineString { points, .. } => Some(points),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()?;
            Some(WkbGeometry::MultiLineString { dims, lines })
        }
        6 => {
            let count = usize::try_from(reader.read_u32(endian)?).ok()?;
            let polygons = (0..count)
                .map(|_| match parse_wkb_geometry(reader)? {
                    WkbGeometry::Polygon { rings, .. } => Some(rings),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()?;
            Some(WkbGeometry::MultiPolygon { dims, polygons })
        }
        7 => {
            let count = usize::try_from(reader.read_u32(endian)?).ok()?;
            let geometries = (0..count).map(|_| parse_wkb_geometry(reader)).collect::<Option<Vec<_>>>()?;
            Some(WkbGeometry::GeometryCollection { dims, geometries })
        }
        _ => None,
    }
}

/// Parse WKB/EWKB bytes into a WKT (Well-Known Text) string.
///
/// Supports both standard WKB (MySQL) and Extended WKB (PostgreSQL/PostGIS).
/// Returns `None` if the bytes cannot be parsed as valid WKB.
pub(crate) fn wkb_to_wkt(raw: &[u8]) -> Option<String> {
    let mut reader = WkbReader::new(raw);
    let geometry = parse_wkb_geometry(&mut reader)?;
    if reader.pos != raw.len() {
        return None;
    }
    Some(geometry.to_wkt())
}
