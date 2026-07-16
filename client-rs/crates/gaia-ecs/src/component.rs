use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub type ComponentId = u32;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    F32,
    F64,
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    Bool,
    Entity,
    Vec2,
    Vec3,
    Vec4,
    Quat,
    Object,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum FieldSpec {
    Type(FieldType),
    Detail(FieldDescriptor),
}
impl FieldSpec {
    pub fn kind(&self) -> FieldType {
        match self {
            Self::Type(kind) => kind.clone(),
            Self::Detail(detail) => detail.kind.clone(),
        }
    }
    pub fn default(&self) -> Option<&Value> {
        match self {
            Self::Type(_) => None,
            Self::Detail(detail) => detail.default.as_ref(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct FieldDescriptor {
    #[serde(rename = "type")]
    pub kind: FieldType,
    #[serde(default)]
    pub default: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ComponentDescriptor {
    pub name: String,
    #[serde(default)]
    pub fields: BTreeMap<String, FieldSpec>,
    #[serde(default)]
    pub enableable: bool,
    #[serde(default)]
    pub buffer: bool,
    #[serde(default)]
    pub default: Option<Value>,
}

#[derive(Clone, Debug)]
pub struct ComponentType {
    pub id: ComponentId,
    pub descriptor: ComponentDescriptor,
}
impl ComponentType {
    pub fn name(&self) -> &str {
        &self.descriptor.name
    }
}

#[derive(Clone, Debug)]
pub(crate) enum FieldColumn {
    F32(Vec<f32>),
    F64(Vec<f64>),
    I8(Vec<i8>),
    U8(Vec<u8>),
    I16(Vec<i16>),
    U16(Vec<u16>),
    I32(Vec<i32>),
    U32(Vec<u32>),
    Bool(Vec<bool>),
    Entity(Vec<i32>),
    Vector { data: Vec<f32>, width: usize },
    Object(Vec<Value>),
}
impl FieldColumn {
    pub(crate) fn new(kind: FieldType, capacity: usize) -> Self {
        match kind {
            FieldType::F32 => Self::F32(vec![0.0; capacity]),
            FieldType::F64 => Self::F64(vec![0.0; capacity]),
            FieldType::I8 => Self::I8(vec![0; capacity]),
            FieldType::U8 => Self::U8(vec![0; capacity]),
            FieldType::I16 => Self::I16(vec![0; capacity]),
            FieldType::U16 => Self::U16(vec![0; capacity]),
            FieldType::I32 => Self::I32(vec![0; capacity]),
            FieldType::U32 => Self::U32(vec![0; capacity]),
            FieldType::Bool => Self::Bool(vec![false; capacity]),
            FieldType::Entity => Self::Entity(vec![0; capacity]),
            FieldType::Vec2 => Self::Vector {
                data: vec![0.0; capacity * 2],
                width: 2,
            },
            FieldType::Vec3 => Self::Vector {
                data: vec![0.0; capacity * 3],
                width: 3,
            },
            FieldType::Vec4 | FieldType::Quat => Self::Vector {
                data: vec![0.0; capacity * 4],
                width: 4,
            },
            FieldType::Object => Self::Object(vec![Value::Null; capacity]),
        }
    }
    pub(crate) fn grow(&mut self, capacity: usize) {
        match self {
            Self::F32(v) => v.resize(capacity, 0.0),
            Self::F64(v) => v.resize(capacity, 0.0),
            Self::I8(v) => v.resize(capacity, 0),
            Self::U8(v) => v.resize(capacity, 0),
            Self::I16(v) => v.resize(capacity, 0),
            Self::U16(v) => v.resize(capacity, 0),
            Self::I32(v) => v.resize(capacity, 0),
            Self::U32(v) => v.resize(capacity, 0),
            Self::Bool(v) => v.resize(capacity, false),
            Self::Entity(v) => v.resize(capacity, 0),
            Self::Object(v) => v.resize(capacity, Value::Null),
            Self::Vector { data, width } => data.resize(capacity * *width, 0.0),
        }
    }
    pub(crate) fn set(&mut self, row: usize, value: &Value) {
        let number = value.as_f64().unwrap_or(0.0);
        match self {
            Self::F32(v) => v[row] = number as f32,
            Self::F64(v) => v[row] = number,
            Self::I8(v) => v[row] = number as i8,
            Self::U8(v) => v[row] = number as u8,
            Self::I16(v) => v[row] = number as i16,
            Self::U16(v) => v[row] = number as u16,
            Self::I32(v) => v[row] = number as i32,
            Self::U32(v) => v[row] = number as u32,
            Self::Entity(v) => v[row] = number as i32,
            Self::Bool(v) => v[row] = value.as_bool().unwrap_or(number != 0.0),
            Self::Object(v) => v[row] = value.clone(),
            Self::Vector { data, width } => {
                for i in 0..*width {
                    data[row * *width + i] =
                        value.get(i).and_then(Value::as_f64).unwrap_or(0.0) as f32
                }
            }
        }
    }
    pub(crate) fn get(&self, row: usize) -> Value {
        match self {
            Self::F32(v) => Value::from(v[row]),
            Self::F64(v) => Value::from(v[row]),
            Self::I8(v) => Value::from(v[row]),
            Self::U8(v) => Value::from(v[row]),
            Self::I16(v) => Value::from(v[row]),
            Self::U16(v) => Value::from(v[row]),
            Self::I32(v) => Value::from(v[row]),
            Self::U32(v) => Value::from(v[row]),
            Self::Entity(v) => Value::from(v[row]),
            Self::Bool(v) => Value::from(v[row]),
            Self::Object(v) => v[row].clone(),
            Self::Vector { data, width } => Value::Array(
                (0..*width)
                    .map(|i| Value::from(data[row * *width + i]))
                    .collect(),
            ),
        }
    }
    pub(crate) fn copy(&mut self, from: usize, to: usize) {
        let value = self.get(from);
        self.set(to, &value);
    }
}

pub(crate) struct ComponentColumn {
    pub fields: BTreeMap<String, FieldColumn>,
    pub buffers: Option<Vec<Value>>,
    pub enabled: Option<Vec<bool>>,
    pub capacity: usize,
}
impl ComponentColumn {
    pub(crate) fn new(component: &ComponentType, capacity: usize) -> Self {
        let fields = component
            .descriptor
            .fields
            .iter()
            .map(|(name, spec)| (name.clone(), FieldColumn::new(spec.kind(), capacity)))
            .collect();
        Self {
            fields,
            buffers: component
                .descriptor
                .buffer
                .then(|| vec![Value::Array(vec![]); capacity]),
            enabled: component
                .descriptor
                .enableable
                .then(|| vec![true; capacity]),
            capacity,
        }
    }
    pub(crate) fn grow(&mut self, capacity: usize) {
        if capacity <= self.capacity {
            return;
        }
        for field in self.fields.values_mut() {
            field.grow(capacity);
        }
        if let Some(buffers) = &mut self.buffers {
            buffers.resize(capacity, Value::Array(vec![]));
        }
        if let Some(enabled) = &mut self.enabled {
            enabled.resize(capacity, true);
        }
        self.capacity = capacity;
    }
    pub(crate) fn set(&mut self, component: &ComponentType, row: usize, value: Option<&Value>) {
        let value = value
            .cloned()
            .unwrap_or_else(|| component_default(component));
        if let Some(buffers) = &mut self.buffers {
            buffers[row] = value;
            return;
        }
        for (name, spec) in &component.descriptor.fields {
            let field_value = value
                .get(name)
                .cloned()
                .or_else(|| spec.default().cloned())
                .unwrap_or_else(|| default_for(spec.kind()));
            self.fields.get_mut(name).unwrap().set(row, &field_value);
        }
    }
    pub(crate) fn get(&self, component: &ComponentType, row: usize) -> Value {
        if let Some(buffers) = &self.buffers {
            return buffers[row].clone();
        }
        let mut output = Map::new();
        for name in component.descriptor.fields.keys() {
            output.insert(name.clone(), self.fields[name].get(row));
        }
        Value::Object(output)
    }
    pub(crate) fn swap_remove(&mut self, row: usize, last: usize) {
        if row == last {
            return;
        }
        for field in self.fields.values_mut() {
            field.copy(last, row);
        }
        if let Some(buffers) = &mut self.buffers {
            buffers[row] = buffers[last].clone();
        }
        if let Some(enabled) = &mut self.enabled {
            enabled[row] = enabled[last];
        }
    }
}

pub fn component_default(component: &ComponentType) -> Value {
    if let Some(value) = &component.descriptor.default {
        return value.clone();
    }
    if component.descriptor.buffer {
        return Value::Array(vec![]);
    }
    let mut output = Map::new();
    for (name, spec) in &component.descriptor.fields {
        output.insert(
            name.clone(),
            spec.default()
                .cloned()
                .unwrap_or_else(|| default_for(spec.kind())),
        );
    }
    Value::Object(output)
}
fn default_for(kind: FieldType) -> Value {
    match kind {
        FieldType::Object => Value::Null,
        FieldType::Vec2 => Value::Array(vec![0.into(), 0.into()]),
        FieldType::Vec3 => Value::Array(vec![0.into(), 0.into(), 0.into()]),
        FieldType::Vec4 | FieldType::Quat => {
            Value::Array(vec![0.into(), 0.into(), 0.into(), 0.into()])
        }
        FieldType::Bool => Value::Bool(false),
        _ => Value::from(0),
    }
}
