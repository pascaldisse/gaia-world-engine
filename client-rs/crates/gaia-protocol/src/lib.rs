//! Serde types for GAIA authored world documents and WebSocket traffic.
//!
//! Authored data is deliberately forward-compatible: every typed object has
//! a flattened `extra` map so newer schema fields survive a Rust read/write.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Number, Value};
use std::collections::BTreeMap;

pub type JsonMap = Map<String, Value>;
pub type EntityMap = BTreeMap<String, EntityDoc>;
pub type MaterialLibrary = BTreeMap<String, MaterialSpec>;

/// A scene entity document. Known GAIA components are typed; unknown component
/// keys stay in `extra` so a newer world schema remains lossless.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EntityDoc {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefab: Option<PrefabRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform: Option<Transform>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ground: Option<Ground>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh: Option<Mesh>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub animation: Option<Animation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ecs: Option<Ecs>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<Health>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weapon: Option<Weapon>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub armor: Option<Armor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ped: Option<Ped>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wanted: Option<Wanted>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safezone: Option<Safezone>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub light: Option<Light>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terrain: Option<Terrain>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<Environment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn: Option<Spawn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behavior: Option<OneOrMany<Behavior>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sound: Option<Sound>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sfx: Option<Sfx>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weather: Option<Weather>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warp: Option<Warp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence: Option<Presence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scatter: Option<Scatter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub particles: Option<Particles>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collider: Option<Collider>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub water: Option<Water>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<Trigger>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interact: Option<Interact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persist: Option<JsonMap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene: Option<SceneStamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera: Option<Camera>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locomotion: Option<Locomotion>,
    #[serde(rename = "characterCreator", skip_serializing_if = "Option::is_none")]
    pub character_creator: Option<CharacterCreator>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

/// Scene prefab instance link. The rest of the [`EntityDoc`] is its delta.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PrefabRef {
    Name(String),
    Detailed(PrefabLink),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PrefabLink {
    pub name: String,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Transform {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Vec<Number>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<Vec<Number>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<NumberOrNumbers>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NumberOrNumbers {
    Number(Number),
    Numbers(Vec<Number>),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Ground {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Mesh {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<MeshPart>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vrm: Option<Value>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MeshPart {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Vec<Number>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<Vec<Number>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emissive: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emissive_intensity: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roughness: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metalness: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<Number>,
    /// Asset URL for `shape: "model"` parts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub animated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(rename = "placeholderSize", skip_serializing_if = "Option::is_none")]
    pub placeholder_size: Option<Vec<Number>>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Animation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip: Option<String>,
    #[serde(rename = "loop", skip_serializing_if = "Option::is_none")]
    pub loop_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fade: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto: Option<AnimationAuto>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AnimationAuto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub walk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    #[serde(rename = "idleBelow", skip_serializing_if = "Option::is_none")]
    pub idle_below: Option<Number>,
    #[serde(rename = "runAbove", skip_serializing_if = "Option::is_none")]
    pub run_above: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Ecs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub components: Option<JsonMap>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Health {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hp: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Weapon {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ammo: Option<Number>,
    #[serde(rename = "lastFire", skip_serializing_if = "Option::is_none")]
    pub last_fire: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reloading: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Armor {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<Number>,
    #[serde(rename = "damageReduction", skip_serializing_if = "Option::is_none")]
    pub damage_reduction: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Ped {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<Number>,
    #[serde(rename = "fleeUntil", skip_serializing_if = "Option::is_none")]
    pub flee_until: Option<Number>,
    #[serde(rename = "diedAt", skip_serializing_if = "Option::is_none")]
    pub died_at: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Wanted {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Safezone {
    #[serde(rename = "decayRate", skip_serializing_if = "Option::is_none")]
    pub decay_rate: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Light {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intensity: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<Vec<Number>>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Terrain {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segments: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amplitude: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Environment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fog: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exposure: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hemisphere: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sun: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bloom: Option<Value>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Spawn {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Vec<Number>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yaw: Option<Number>,
    #[serde(rename = "gameMode", skip_serializing_if = "Option::is_none")]
    pub game_mode: Option<bool>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Behavior {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OneOrMany<T> {
    One(T),
    Many(Vec<T>),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Sound {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Sfx {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wave: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Weather {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lightning: Option<bool>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Warp {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Vec<Number>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yaw: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fade: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Presence {
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Scatter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Particles {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Collider {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boxes: Option<Vec<Value>>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Water {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Trigger {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Interact {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SceneStamp {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Camera {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Locomotion {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub walk: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<Number>,
    #[serde(rename = "backwardFactor", skip_serializing_if = "Option::is_none")]
    pub backward_factor: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CharacterCreator {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PrefabDoc {
    pub name: String,
    pub components: EntityDoc,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WorldMeta {
    #[serde(default)]
    pub scenes: BTreeMap<String, SceneSpec>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SceneSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub always: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub neighbors: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load: Option<Vec<LoadVolume>>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LoadVolume {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub center: Option<Vec<Number>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<Vec<Number>>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MaterialSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emissive: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roughness: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metalness: Option<Number>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

/// HTTP and client-to-server operation batch. `dev` marks authored write-back.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct OpBatch {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dev: bool,
    #[serde(default)]
    pub ops: Vec<Op>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Set(SetOp),
    Scene(SceneOp),
    Material(MaterialOp),
    Reset(ResetOp),
    Use(UseOp),
    Other { op: String, fields: JsonMap },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SetOp {
    pub id: String,
    pub component: String,
    #[serde(default)]
    pub value: Value,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SceneOp {
    pub name: String,
    #[serde(default)]
    pub value: Value,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MaterialOp {
    pub name: String,
    #[serde(default)]
    pub value: Value,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ResetOp {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct UseOp {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

impl<'de> Deserialize<'de> for Op {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut object = JsonMap::deserialize(deserializer)?;
        let op = object
            .remove("op")
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or_else(|| serde::de::Error::missing_field("op"))?;
        let value = Value::Object(object.clone());
        match op.as_str() {
            "set" => serde_json::from_value::<SetOp>(value)
                .map(Op::Set)
                .map_err(serde::de::Error::custom),
            "scene" => serde_json::from_value::<SceneOp>(value)
                .map(Op::Scene)
                .map_err(serde::de::Error::custom),
            "material" => serde_json::from_value::<MaterialOp>(value)
                .map(Op::Material)
                .map_err(serde::de::Error::custom),
            "reset" => serde_json::from_value::<ResetOp>(value)
                .map(Op::Reset)
                .map_err(serde::de::Error::custom),
            "use" => serde_json::from_value::<UseOp>(value)
                .map(Op::Use)
                .map_err(serde::de::Error::custom),
            _ => Ok(Op::Other { op, fields: object }),
        }
    }
}

impl Serialize for Op {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let (name, value) = match self {
            Op::Set(v) => ("set", serde_json::to_value(v)),
            Op::Scene(v) => ("scene", serde_json::to_value(v)),
            Op::Material(v) => ("material", serde_json::to_value(v)),
            Op::Reset(v) => ("reset", serde_json::to_value(v)),
            Op::Use(v) => ("use", serde_json::to_value(v)),
            Op::Other { op, fields } => (op.as_str(), Ok(Value::Object(fields.clone()))),
        };
        let mut object = value
            .map_err(serde::ser::Error::custom)?
            .as_object()
            .cloned()
            .ok_or_else(|| serde::ser::Error::custom("operation must serialize as an object"))?;
        object.insert("op".into(), Value::String(name.into()));
        object.serialize(serializer)
    }
}

/// WebSocket messages sent by the GAIA server/client. Unknown message types
/// retain their complete payload in `Other`.
#[derive(Clone, Debug, PartialEq)]
pub enum WsMessage {
    Snapshot(SnapshotMessage),
    Ops(WsOpsMessage),
    Hello(HelloMessage),
    ScreenshotRequest(ScreenshotRequest),
    Screenshot(ScreenshotMessage),
    Other { kind: String, fields: JsonMap },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SnapshotMessage {
    #[serde(default)]
    pub time: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world: Option<WorldMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub materials: Option<MaterialLibrary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counter: Option<u64>,
    #[serde(default)]
    pub entities: EntityMap,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WsOpsMessage {
    #[serde(default)]
    pub ops: Vec<Op>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dev: bool,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct HelloMessage {
    pub presence: String,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ScreenshotRequest {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ScreenshotMessage {
    pub id: u64,
    pub data: String,
    #[serde(flatten)]
    pub extra: JsonMap,
}

impl<'de> Deserialize<'de> for WsMessage {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut object = JsonMap::deserialize(deserializer)?;
        let kind = object
            .remove("type")
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or_else(|| serde::de::Error::missing_field("type"))?;
        let value = Value::Object(object.clone());
        match kind.as_str() {
            "snapshot" => serde_json::from_value::<SnapshotMessage>(value)
                .map(WsMessage::Snapshot)
                .map_err(serde::de::Error::custom),
            "ops" => serde_json::from_value::<WsOpsMessage>(value)
                .map(WsMessage::Ops)
                .map_err(serde::de::Error::custom),
            "hello" => serde_json::from_value::<HelloMessage>(value)
                .map(WsMessage::Hello)
                .map_err(serde::de::Error::custom),
            "screenshot-request" => serde_json::from_value::<ScreenshotRequest>(value)
                .map(WsMessage::ScreenshotRequest)
                .map_err(serde::de::Error::custom),
            "screenshot" => serde_json::from_value::<ScreenshotMessage>(value)
                .map(WsMessage::Screenshot)
                .map_err(serde::de::Error::custom),
            _ => Ok(WsMessage::Other {
                kind,
                fields: object,
            }),
        }
    }
}

impl Serialize for WsMessage {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let (kind, value) = match self {
            WsMessage::Snapshot(v) => ("snapshot", serde_json::to_value(v)),
            WsMessage::Ops(v) => ("ops", serde_json::to_value(v)),
            WsMessage::Hello(v) => ("hello", serde_json::to_value(v)),
            WsMessage::ScreenshotRequest(v) => ("screenshot-request", serde_json::to_value(v)),
            WsMessage::Screenshot(v) => ("screenshot", serde_json::to_value(v)),
            WsMessage::Other { kind, fields } => (kind.as_str(), Ok(Value::Object(fields.clone()))),
        };
        let mut object = value
            .map_err(serde::ser::Error::custom)?
            .as_object()
            .cloned()
            .ok_or_else(|| serde::ser::Error::custom("message must serialize as an object"))?;
        object.insert("type".into(), Value::String(kind.into()));
        object.serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap()
    }
    fn json(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    fn json_files(root: &Path) -> Vec<PathBuf> {
        fn visit(dir: &Path, paths: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    visit(&path, paths);
                } else if path.extension().is_some_and(|ext| ext == "json") {
                    paths.push(path);
                }
            }
        }
        let mut paths = Vec::new();
        visit(root, &mut paths);
        paths.sort();
        paths
    }

    #[test]
    fn parses_every_authored_world_document_and_roundtrips_main_scene() {
        let root = repo_root().join("world");
        for dir in ["scenes", "prefabs"] {
            let mut paths: Vec<_> = fs::read_dir(root.join(dir))
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
                .collect();
            paths.sort();
            for path in paths {
                let source = json(&path);
                if dir == "scenes" {
                    let _: EntityMap = serde_json::from_value(source).unwrap();
                } else {
                    let _: PrefabDoc = serde_json::from_value(source).unwrap();
                }
            }
        }
        let _: WorldMeta = serde_json::from_value(json(&root.join("world.json"))).unwrap();
        let materials = root.join("materials.json");
        if materials.exists() {
            let _: MaterialLibrary = serde_json::from_value(json(&materials)).unwrap();
        } else {
            eprintln!("world/materials.json absent; server treats it as an empty material library");
        }

        let source = json(&root.join("scenes/main.json"));
        let scene: EntityMap = serde_json::from_value(source.clone()).unwrap();
        assert_eq!(serde_json::to_value(scene).unwrap(), source);
    }

    #[test]
    fn parses_boomtown_world_when_available() {
        let root = std::env::var_os("GAIA_BOOMTOWN_WORLD")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(
                    "/Users/pascaldisse/projects/GAIA-World-Engine-unity/tools/unity/out/boomtown-world",
                )
            });
        if !root.is_dir() {
            eprintln!("GAIA Boomtown world absent; skipping: {}", root.display());
            return;
        }

        let paths = json_files(&root);
        assert!(!paths.is_empty(), "Boomtown world contains no JSON files");
        for path in &paths {
            let source = fs::read_to_string(path)
                .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
            let _: Value = serde_json::from_str(&source)
                .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()));
        }

        let scenes = root.join("scenes");
        let mut entity_count = 0;
        for path in json_files(&scenes) {
            let entities: EntityMap = serde_json::from_value(json(&path))
                .unwrap_or_else(|error| panic!("typed scene {}: {error}", path.display()));
            entity_count += entities.len();
        }
        assert_eq!(entity_count, 5_261, "Boomtown scene entity count");

        for path in json_files(&root.join("prefabs")) {
            let _: PrefabDoc = serde_json::from_value(json(&path))
                .unwrap_or_else(|error| panic!("typed prefab {}: {error}", path.display()));
        }
        eprintln!(
            "Boomtown parsed: {} JSON files, {entity_count} scene entities, zero parse errors",
            paths.len()
        );
    }

    #[test]
    fn typed_boomtown_components_and_model_parts_deserialize() {
        let entity: EntityDoc = serde_json::from_value(serde_json::json!({
            "mesh": {"parts": [{"shape": "model", "src": "/assets/ped.glb", "animated": true, "variant": "coat", "placeholderSize": [1, 2, 3]}]},
            "animation": {"clip": "idle", "loop": "repeat", "speed": 1, "fade": 0.2, "step": 12, "futureAnimationField": true, "auto": {"idle": "idle", "walk": "walk", "run": "run", "idleBelow": 0.1, "runAbove": 2.5}},
            "ecs": {"enabled": true, "components": {"LocalTransform": {}}},
            "health": {"hp": 10, "max": 20},
            "weapon": {"name": "Pistol", "ammo": 6, "lastFire": 4, "reloading": 5},
            "armor": {"current": 3, "max": 4, "damageReduction": 0.3},
            "ped": {"node": "a", "target": "b", "state": "flee", "speed": 3, "fleeUntil": 4, "diedAt": 5},
            "wanted": {"points": 10, "level": 1},
            "safezone": {"decayRate": 5},
            "locomotion": {"walk": 4, "run": 8, "backwardFactor": 0.7}
        }))
        .unwrap();
        let model = &entity.mesh.as_ref().unwrap().parts.as_ref().unwrap()[0];
        assert_eq!(model.shape.as_deref(), Some("model"));
        assert_eq!(model.src.as_deref(), Some("/assets/ped.glb"));
        assert_eq!(model.animated, Some(true));
        assert_eq!(model.variant.as_deref(), Some("coat"));
        assert_eq!(model.placeholder_size.as_ref().unwrap().len(), 3);
        assert!(entity
            .animation
            .as_ref()
            .unwrap()
            .extra
            .contains_key("futureAnimationField"));
        assert!(entity.animation.is_some());
        assert!(entity.ecs.is_some());
        assert!(entity.health.is_some());
        assert!(entity.weapon.is_some());
        assert!(entity.armor.is_some());
        assert!(entity.ped.is_some());
        assert!(entity.wanted.is_some());
        assert!(entity.safezone.is_some());
        assert!(entity.locomotion.is_some());
    }

    #[test]
    fn preserves_unknown_ops_and_messages() {
        let op: Op =
            serde_json::from_value(serde_json::json!({"op":"warp","id":"p1","fade":true})).unwrap();
        assert_eq!(
            serde_json::to_value(op).unwrap(),
            serde_json::json!({"op":"warp","id":"p1","fade":true})
        );
        let message: WsMessage =
            serde_json::from_value(serde_json::json!({"type":"new-wire-kind","future":42}))
                .unwrap();
        assert_eq!(
            serde_json::to_value(message).unwrap(),
            serde_json::json!({"type":"new-wire-kind","future":42})
        );
    }
}
