use crate::EcsWorld;
use std::collections::{HashMap, HashSet};

pub const INITIALIZATION: &str = "InitializationSystemGroup";
pub const SIMULATION: &str = "SimulationSystemGroup";
pub const FIXED: &str = "FixedStepSimulationSystemGroup";
pub const PRESENTATION: &str = "PresentationSystemGroup";
pub const DEFAULT_FIXED_DELTA: f64 = 0.02;
pub const DEFAULT_MAX_FIXED_STEPS: u32 = 8;

#[derive(Clone, Debug, Default)]
pub struct ScheduleOptions {
    pub fixed_delta: Option<f64>,
    pub max_fixed_steps: Option<u32>,
}
#[derive(Clone, Debug, Default)]
pub struct ItemOptions {
    pub parent: Option<String>,
    pub before: Vec<String>,
    pub after: Vec<String>,
    pub order_first: bool,
    pub order_last: bool,
    pub enabled: Option<bool>,
    pub fixed_delta: Option<f64>,
    pub max_steps: Option<u32>,
}
#[derive(Clone, Debug)]
pub struct SystemContext {
    pub delta_time: f64,
    pub elapsed_time: f64,
    pub fixed: bool,
    pub alpha: f64,
    pub group: String,
}
type SystemFn = Box<dyn FnMut(&mut EcsWorld, SystemContext)>;
struct Group {
    parent: Option<String>,
    before: Vec<String>,
    after: Vec<String>,
    order_first: bool,
    order_last: bool,
    enabled: bool,
    fixed_delta: Option<f64>,
    max_steps: u32,
    accumulator: f64,
    children: Vec<Node>,
    order: u64,
}
struct System {
    parent: String,
    before: Vec<String>,
    after: Vec<String>,
    order_first: bool,
    order_last: bool,
    enabled: bool,
    update: Option<SystemFn>,
    order: u64,
}
#[derive(Clone)]
enum Node {
    Group(String),
    System(String),
}
impl Node {
    fn name(&self) -> &str {
        match self {
            Self::Group(name) | Self::System(name) => name,
        }
    }
}

pub struct Scheduler {
    pub world: EcsWorld,
    elapsed_time: f64,
    sequence: u64,
    groups: HashMap<String, Group>,
    systems: HashMap<String, System>,
    compiled: bool,
}
impl Scheduler {
    pub fn new(world: EcsWorld, options: ScheduleOptions) -> Self {
        let mut scheduler = Self {
            world,
            elapsed_time: 0.0,
            sequence: 0,
            groups: HashMap::new(),
            systems: HashMap::new(),
            compiled: false,
        };
        scheduler
            .add_group(INITIALIZATION, ItemOptions::default())
            .unwrap();
        scheduler
            .add_group(SIMULATION, ItemOptions::default())
            .unwrap();
        scheduler
            .add_group(
                FIXED,
                ItemOptions {
                    parent: Some(SIMULATION.into()),
                    fixed_delta: Some(options.fixed_delta.unwrap_or(DEFAULT_FIXED_DELTA)),
                    max_steps: Some(options.max_fixed_steps.unwrap_or(DEFAULT_MAX_FIXED_STEPS)),
                    ..Default::default()
                },
            )
            .unwrap();
        scheduler
            .add_group(PRESENTATION, ItemOptions::default())
            .unwrap();
        scheduler
    }
    pub fn add_group(
        &mut self,
        name: impl Into<String>,
        options: ItemOptions,
    ) -> Result<(), String> {
        let name = name.into();
        if self.groups.contains_key(&name) || self.systems.contains_key(&name) {
            return Err(format!("duplicate ECS schedule item {name}"));
        }
        if options.fixed_delta.is_some_and(|delta| delta <= 0.0) {
            return Err(format!("{name} fixedDelta must be > 0"));
        }
        let order = self.next_sequence();
        self.groups.insert(
            name,
            Group {
                parent: options.parent,
                before: options.before,
                after: options.after,
                order_first: options.order_first,
                order_last: options.order_last,
                enabled: options.enabled.unwrap_or(true),
                fixed_delta: options.fixed_delta,
                max_steps: options.max_steps.unwrap_or(DEFAULT_MAX_FIXED_STEPS),
                accumulator: 0.0,
                children: vec![],
                order,
            },
        );
        self.compiled = false;
        Ok(())
    }
    pub fn add_system<F>(
        &mut self,
        name: impl Into<String>,
        update: F,
        options: ItemOptions,
    ) -> Result<(), String>
    where
        F: FnMut(&mut EcsWorld, SystemContext) + 'static,
    {
        let name = name.into();
        if self.groups.contains_key(&name) || self.systems.contains_key(&name) {
            return Err(format!("duplicate ECS schedule item {name}"));
        }
        let order = self.next_sequence();
        self.systems.insert(
            name,
            System {
                parent: options.parent.unwrap_or_else(|| SIMULATION.into()),
                before: options.before,
                after: options.after,
                order_first: options.order_first,
                order_last: options.order_last,
                enabled: options.enabled.unwrap_or(true),
                update: Some(Box::new(update)),
                order,
            },
        );
        self.compiled = false;
        Ok(())
    }
    pub fn set_system_enabled(&mut self, name: &str, enabled: bool) -> Result<(), String> {
        self.systems
            .get_mut(name)
            .ok_or_else(|| format!("unknown ECS system {name}"))?
            .enabled = enabled;
        Ok(())
    }
    pub fn set_group_enabled(&mut self, name: &str, enabled: bool) -> Result<(), String> {
        self.groups
            .get_mut(name)
            .ok_or_else(|| format!("unknown ECS group {name}"))?
            .enabled = enabled;
        Ok(())
    }
    pub fn compile(&mut self) -> Result<(), String> {
        for group in self.groups.values_mut() {
            group.children.clear();
        }
        let edges: Vec<_> = self
            .groups
            .iter()
            .filter_map(|(name, group)| {
                group
                    .parent
                    .clone()
                    .map(|parent| (parent, Node::Group(name.clone())))
            })
            .chain(
                self.systems
                    .iter()
                    .map(|(name, system)| (system.parent.clone(), Node::System(name.clone()))),
            )
            .collect();
        for (parent, child) in edges {
            self.groups
                .get_mut(&parent)
                .ok_or_else(|| format!("{}: unknown UpdateInGroup {parent}", child.name()))?
                .children
                .push(child);
        }
        let names: Vec<_> = self.groups.keys().cloned().collect();
        for name in names {
            let children = self.groups[&name].children.clone();
            self.groups.get_mut(&name).unwrap().children = self.sort_children(&name, children)?;
        }
        self.compiled = true;
        Ok(())
    }
    pub fn tick(&mut self, delta_time: f64) -> Result<(), String> {
        if delta_time < 0.0 {
            return Err("deltaTime must be >= 0".into());
        }
        if !self.compiled {
            self.compile()?;
        }
        self.elapsed_time += delta_time;
        let context = SystemContext {
            delta_time,
            elapsed_time: self.elapsed_time,
            fixed: false,
            alpha: 1.0,
            group: String::new(),
        };
        for root in [INITIALIZATION, SIMULATION, PRESENTATION] {
            self.run_group(root, context.clone())?;
        }
        Ok(())
    }
    pub fn fixed_alpha(&self, name: Option<&str>) -> f64 {
        let Some(group) = self.groups.get(name.unwrap_or(FIXED)) else {
            return 1.0;
        };
        group
            .fixed_delta
            .map(|delta| (group.accumulator / delta).min(1.0))
            .unwrap_or(1.0)
    }
    pub fn ordered_names(&mut self, name: &str) -> Result<Vec<String>, String> {
        if !self.compiled {
            self.compile()?;
        }
        Ok(self
            .groups
            .get(name)
            .ok_or_else(|| format!("unknown ECS group {name}"))?
            .children
            .iter()
            .map(|child| child.name().to_owned())
            .collect())
    }
    fn run_group(&mut self, name: &str, context: SystemContext) -> Result<(), String> {
        let (enabled, fixed_delta, max_steps) = {
            let group = self
                .groups
                .get(name)
                .ok_or_else(|| format!("unknown ECS group {name}"))?;
            (group.enabled, group.fixed_delta, group.max_steps)
        };
        if !enabled {
            return Ok(());
        }
        if let Some(delta) = fixed_delta {
            self.groups.get_mut(name).unwrap().accumulator += context.delta_time;
            let mut steps = 0;
            while self.groups[name].accumulator + f64::EPSILON >= delta && steps < max_steps {
                let accumulator = self.groups[name].accumulator;
                let fixed = SystemContext {
                    delta_time: delta,
                    elapsed_time: context.elapsed_time - accumulator + delta,
                    fixed: true,
                    alpha: 0.0,
                    group: String::new(),
                };
                self.run_children(name, fixed)?;
                self.groups.get_mut(name).unwrap().accumulator -= delta;
                steps += 1;
            }
            if steps == max_steps && self.groups[name].accumulator >= delta {
                self.groups.get_mut(name).unwrap().accumulator %= delta;
            }
        } else {
            self.run_children(name, context)?;
        }
        Ok(())
    }
    fn run_children(&mut self, group: &str, context: SystemContext) -> Result<(), String> {
        let children = self.groups[group].children.clone();
        for child in children {
            match child {
                Node::Group(name) => self.run_group(&name, context.clone())?,
                Node::System(name) => {
                    let enabled = self.systems[&name].enabled;
                    if enabled {
                        let mut update =
                            self.systems.get_mut(&name).unwrap().update.take().unwrap();
                        update(
                            &mut self.world,
                            SystemContext {
                                group: group.into(),
                                ..context.clone()
                            },
                        );
                        self.systems.get_mut(&name).unwrap().update = Some(update);
                    }
                }
            }
        }
        Ok(())
    }
    fn sort_children(&self, group: &str, items: Vec<Node>) -> Result<Vec<Node>, String> {
        let names: HashSet<_> = items.iter().map(|item| item.name().to_owned()).collect();
        let mut edges: HashMap<String, HashSet<String>> = names
            .iter()
            .map(|name| (name.clone(), HashSet::new()))
            .collect();
        let mut indegree: HashMap<String, usize> =
            names.iter().map(|name| (name.clone(), 0)).collect();
        let attributes = |name: &str| -> (&Vec<String>, &Vec<String>, bool, bool, u64) {
            if let Some(item) = self.groups.get(name) {
                (
                    &item.before,
                    &item.after,
                    item.order_first,
                    item.order_last,
                    item.order,
                )
            } else {
                let item = &self.systems[name];
                (
                    &item.before,
                    &item.after,
                    item.order_first,
                    item.order_last,
                    item.order,
                )
            }
        };
        let add = |from: &str,
                   to: &str,
                   edges: &mut HashMap<String, HashSet<String>>,
                   indegree: &mut HashMap<String, usize>| {
            if from != to
                && names.contains(from)
                && names.contains(to)
                && edges.get_mut(from).unwrap().insert(to.into())
            {
                *indegree.get_mut(to).unwrap() += 1;
            }
        };
        for item in &items {
            let (before, after, _, _, _) = attributes(item.name());
            for target in before {
                add(item.name(), target, &mut edges, &mut indegree);
            }
            for target in after {
                add(target, item.name(), &mut edges, &mut indegree);
            }
        }
        let first: Vec<_> = items
            .iter()
            .filter(|item| attributes(item.name()).2)
            .collect();
        let middle: Vec<_> = items
            .iter()
            .filter(|item| !attributes(item.name()).2 && !attributes(item.name()).3)
            .collect();
        let last: Vec<_> = items
            .iter()
            .filter(|item| attributes(item.name()).3)
            .collect();
        for left in &first {
            for right in middle.iter().chain(last.iter()) {
                add(left.name(), right.name(), &mut edges, &mut indegree);
            }
        }
        for left in &middle {
            for right in &last {
                add(left.name(), right.name(), &mut edges, &mut indegree);
            }
        }
        let mut by_name: HashMap<_, _> = items
            .into_iter()
            .map(|item| (item.name().to_owned(), item))
            .collect();
        let mut ready: Vec<_> = indegree
            .iter()
            .filter(|(_, degree)| **degree == 0)
            .map(|(name, _)| name.clone())
            .collect();
        ready.sort_by_key(|name| attributes(name).4);
        let mut output = vec![];
        while let Some(name) = ready.first().cloned() {
            ready.remove(0);
            output.push(by_name.remove(&name).unwrap());
            for target in edges[&name].clone() {
                *indegree.get_mut(&target).unwrap() -= 1;
                if indegree[&target] == 0 {
                    ready.push(target);
                    ready.sort_by_key(|name| attributes(name).4);
                }
            }
        }
        if output.len() != names.len() {
            let cycle = names
                .into_iter()
                .filter(|name| indegree[name] > 0)
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "{group}: UpdateBefore/UpdateAfter cycle involving {cycle}"
            ));
        }
        Ok(output)
    }
    fn next_sequence(&mut self) -> u64 {
        let sequence = self.sequence;
        self.sequence += 1;
        sequence
    }
}
