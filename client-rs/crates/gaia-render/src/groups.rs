//! Visibility groups: per-instance u32 bitsets vs a host-set ACTIVE set (generic, any bit count).
//! instance drawn  ⇔  active culling is off (`None`)  ∨  instance has no groups  ∨  mask ∩ active ≠ ∅.
//! An instance with a group PARENT takes the parent's effective mask (chain, cycle-guarded) instead of its own.
use std::collections::HashMap;

/// Chain depth cap for `parent` following (cycle guard; a cycle resolves to "no groups" = drawn).
pub const MAX_PARENT_DEPTH: usize = 32;

/// Bitset over group indices; word `w` bit `b` = group `32*w + b`. Empty / all-zero = "no groups".
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GroupMask(pub Vec<u32>);

impl GroupMask {
    pub fn from_words(words: &[u32]) -> Self {
        let mut v = words.to_vec();
        while v.last() == Some(&0) {
            v.pop();
        }
        Self(v)
    }
    /// From set-bit indices (any magnitude; the set grows to fit).
    pub fn from_bits(bits: &[u32]) -> Self {
        let mut v: Vec<u32> = Vec::new();
        for &b in bits {
            let w = (b / 32) as usize;
            if v.len() <= w {
                v.resize(w + 1, 0);
            }
            v[w] |= 1 << (b % 32);
        }
        Self(v)
    }
    pub fn is_empty(&self) -> bool {
        self.0.iter().all(|w| *w == 0)
    }
    pub fn intersects(&self, other: &GroupMask) -> bool {
        self.0.iter().zip(other.0.iter()).any(|(a, b)| a & b != 0)
    }
    pub fn contains(&self, bit: u32) -> bool {
        self.0.get((bit / 32) as usize).is_some_and(|w| w & (1 << (bit % 32)) != 0)
    }
    /// Union (OR) of several sets.
    pub fn union<'a>(sets: impl IntoIterator<Item = &'a GroupMask>) -> Self {
        let mut v: Vec<u32> = Vec::new();
        for s in sets {
            if v.len() < s.0.len() {
                v.resize(s.0.len(), 0);
            }
            for (i, w) in s.0.iter().enumerate() {
                v[i] |= w;
            }
        }
        Self::from_words(&v)
    }
}

/// Per-instance group data held by the core.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InstanceGroups {
    pub mask: GroupMask,
    /// Instance id whose effective mask this instance follows.
    pub parent: Option<u32>,
}

/// Effective mask of `id` after following the parent chain; `None` = unconstrained (always drawn).
pub fn effective_mask<'a>(groups: &'a HashMap<u32, InstanceGroups>, id: u32) -> Option<&'a GroupMask> {
    let mut cur = id;
    for _ in 0..MAX_PARENT_DEPTH {
        let g = groups.get(&cur)?;
        match g.parent {
            // a parent id that is not a live instance → unconstrained for this link (reported by caller via is_resolved)
            Some(p) if groups.contains_key(&p) => cur = p,
            Some(_) => return None,
            None => return if g.mask.is_empty() { None } else { Some(&g.mask) },
        }
    }
    None
}

/// The draw decision. `active == None` → culling disabled (everything drawn).
pub fn is_drawn(groups: &HashMap<u32, InstanceGroups>, id: u32, active: Option<&GroupMask>) -> bool {
    let Some(active) = active else { return true };
    match effective_mask(groups, id) {
        None => true,
        Some(m) => m.intersects(active),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(bits: &[u32], parent: Option<u32>) -> InstanceGroups {
        InstanceGroups { mask: GroupMask::from_bits(bits), parent }
    }

    #[test]
    fn bits_roundtrip_128_plus() {
        let m = GroupMask::from_bits(&[0, 31, 32, 50, 127, 128, 300]);
        for b in [0, 31, 32, 50, 127, 128, 300] {
            assert!(m.contains(b), "{b}");
        }
        assert!(!m.contains(1) && !m.contains(129) && !m.contains(10_000));
        assert_eq!(m.0.len(), 10);
    }

    #[test]
    fn intersect_and_union() {
        let a = GroupMask::from_bits(&[3, 50]);
        let b = GroupMask::from_bits(&[50, 200]);
        let c = GroupMask::from_bits(&[4]);
        assert!(a.intersects(&b) && b.intersects(&a));
        assert!(!a.intersects(&c));
        let u = GroupMask::union([&a, &c]);
        assert!(u.contains(3) && u.contains(4) && u.contains(50) && !u.contains(200));
        assert!(GroupMask::default().is_empty() && GroupMask::from_words(&[0, 0]).is_empty());
    }

    #[test]
    fn no_active_set_draws_everything() {
        let mut m = HashMap::new();
        m.insert(1, g(&[7], None));
        assert!(is_drawn(&m, 1, None));
    }

    #[test]
    fn drawn_iff_intersects_empty_always_drawn() {
        let mut m = HashMap::new();
        m.insert(1, g(&[50, 51], None));
        m.insert(2, g(&[], None)); // no groups
        let act = GroupMask::from_bits(&[50]);
        let other = GroupMask::from_bits(&[0, 1]);
        assert!(is_drawn(&m, 1, Some(&act)));
        assert!(!is_drawn(&m, 1, Some(&other)));
        assert!(is_drawn(&m, 2, Some(&act)) && is_drawn(&m, 2, Some(&GroupMask::default())));
        // empty active set hides every grouped instance, keeps ungrouped
        assert!(!is_drawn(&m, 1, Some(&GroupMask::default())));
        assert!(is_drawn(&m, 99, Some(&act)), "unknown id = no groups = drawn");
    }

    #[test]
    fn parent_chain_follows_parent_not_own() {
        let mut m = HashMap::new();
        m.insert(1, g(&[50], None)); // piece
        m.insert(2, g(&[0], Some(1))); // object: own mask ignored, follows 1
        m.insert(3, g(&[], Some(2))); // chain
        let act = GroupMask::from_bits(&[50]);
        assert!(is_drawn(&m, 2, Some(&act)) && is_drawn(&m, 3, Some(&act)));
        let act0 = GroupMask::from_bits(&[0]);
        assert!(!is_drawn(&m, 2, Some(&act0)) && !is_drawn(&m, 3, Some(&act0)));
    }

    #[test]
    fn parent_cycle_and_dangling_are_drawn() {
        let mut m = HashMap::new();
        m.insert(1, g(&[5], Some(2)));
        m.insert(2, g(&[5], Some(1)));
        m.insert(3, g(&[5], Some(77)));
        let act = GroupMask::from_bits(&[9]);
        assert!(is_drawn(&m, 1, Some(&act)), "cycle → unconstrained");
        assert!(is_drawn(&m, 3, Some(&act)), "dangling parent → unconstrained");
    }
}
