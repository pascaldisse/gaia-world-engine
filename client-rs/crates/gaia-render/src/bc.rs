//! r13-bc: block-compressed texture (BC1..BC5, BC7 GPU-only) helpers — format table, mip sizes, per-block vertical flip, CPU decode to RGBA8.
//! Generic (three CompressedTexture / GL internal-format enums), no game contract. Upload policy lives in `RenderCore::create_texture_compressed`.
//! Data order contract: blocks row-major, rows as stored in the file/three mipmap (row 0 = first stored row). `flip` converts GL-order (row 0 = v 0 = bottom) to top-first.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bc { Bc1, Bc2, Bc3, Bc4, Bc5, Bc7 }

/// three/GL compressed internal format -> (BC kind, rgb_only). rgb_only = RGB_S3TC_DXT1 (alpha is always 1; BC1 3-colour 'transparent' texels are opaque black).
/// Signed RGTC (36284/36286) and BC6H (36494/36495) are not mapped (None -> loud refusal in the caller).
pub fn from_gl(format: u32) -> Option<(Bc, bool)> {
    Some(match format {
        33776 => (Bc::Bc1, true),
        33777 => (Bc::Bc1, false),
        33778 => (Bc::Bc2, false),
        33779 => (Bc::Bc3, false),
        36283 => (Bc::Bc4, false),
        36285 => (Bc::Bc5, false),
        36492 => (Bc::Bc7, false),
        _ => return None,
    })
}
pub fn block_bytes(f: Bc) -> usize { match f { Bc::Bc1 | Bc::Bc4 => 8, _ => 16 } }
pub fn blocks(w: u32, h: u32) -> (u32, u32) { (w.div_ceil(4).max(1), h.div_ceil(4).max(1)) }
pub fn mip_bytes(f: Bc, w: u32, h: u32) -> usize { let (bw, bh) = blocks(w, h); bw as usize * bh as usize * block_bytes(f) }
pub fn wgpu_format(f: Bc, srgb: bool) -> wgpu::TextureFormat {
    use wgpu::TextureFormat as T;
    match (f, srgb) {
        (Bc::Bc1, false) => T::Bc1RgbaUnorm, (Bc::Bc1, true) => T::Bc1RgbaUnormSrgb,
        (Bc::Bc2, false) => T::Bc2RgbaUnorm, (Bc::Bc2, true) => T::Bc2RgbaUnormSrgb,
        (Bc::Bc3, false) => T::Bc3RgbaUnorm, (Bc::Bc3, true) => T::Bc3RgbaUnormSrgb,
        (Bc::Bc4, _) => T::Bc4RUnorm,
        (Bc::Bc5, _) => T::Bc5RgUnorm,
        (Bc::Bc7, false) => T::Bc7RgbaUnorm, (Bc::Bc7, true) => T::Bc7RgbaUnormSrgb,
    }
}
/// Whether the format can be flipped block-wise without decoding (BC7 cannot).
pub fn flippable(f: Bc) -> bool { f != Bc::Bc7 }

/// row permutation for a mip of height `h`: out row r takes in row perm[r]. h>=4 -> reverse the 4 rows; h<4 -> reverse only the h real rows.
fn perm(h: u32) -> [usize; 4] {
    if h >= 4 { [3, 2, 1, 0] } else { let h = h.max(1) as usize; let mut p = [0, 1, 2, 3]; for r in 0..h { p[r] = h - 1 - r; } p }
}
fn flip_alpha_idx(b: &mut [u8], p: &[usize; 4]) {
    // 8-byte BC4/BC3-alpha block: 2 endpoint bytes + 16 x 3-bit indices (row-major, 12 bits per row)
    let mut bits = 0u64; for i in 0..6 { bits |= (b[2 + i] as u64) << (8 * i); }
    let mut out = 0u64;
    for r in 0..4 { let row = (bits >> (12 * p[r])) & 0xfff; out |= row << (12 * r); }
    for i in 0..6 { b[2 + i] = (out >> (8 * i)) as u8; }
}
fn flip_bc1_idx(b: &mut [u8], p: &[usize; 4]) { // 4-byte colour block indices after the 2 endpoints: 1 byte per row
    let o = [b[0], b[1], b[2], b[3]]; for r in 0..4 { b[r] = o[p[r]]; }
}
/// Flip one block's rows in place (see `perm`). Not valid for BC7 (caller gates on `flippable`).
pub fn flip_block(f: Bc, blk: &mut [u8], h: u32) {
    let p = perm(h);
    match f {
        Bc::Bc1 => flip_bc1_idx(&mut blk[4..8], &p),
        Bc::Bc2 => { let o: Vec<[u8; 2]> = (0..4).map(|r| [blk[2 * r], blk[2 * r + 1]]).collect(); for r in 0..4 { blk[2 * r] = o[p[r]][0]; blk[2 * r + 1] = o[p[r]][1]; } flip_bc1_idx(&mut blk[12..16], &p) }
        Bc::Bc3 => { flip_alpha_idx(&mut blk[0..8], &p); flip_bc1_idx(&mut blk[12..16], &p) }
        Bc::Bc4 => flip_alpha_idx(&mut blk[0..8], &p),
        Bc::Bc5 => { flip_alpha_idx(&mut blk[0..8], &p); flip_alpha_idx(&mut blk[8..16], &p) }
        Bc::Bc7 => {}
    }
}
/// Flip a whole mip (w x h texels) vertically: reverse block rows + rows inside each block. Exact when h%4==0 or h<4 (caller checks `flip_exact`).
pub fn flip_mip(f: Bc, w: u32, h: u32, data: &[u8]) -> Vec<u8> {
    let (bw, bh) = blocks(w, h); let bb = block_bytes(f); let row = bw as usize * bb;
    let mut out = vec![0u8; data.len()];
    for by in 0..bh as usize { let src = &data[by * row..(by + 1) * row]; let dst = &mut out[(bh as usize - 1 - by) * row..(bh as usize - by) * row]; dst.copy_from_slice(src);
        for bx in 0..bw as usize { flip_block(f, &mut dst[bx * bb..(bx + 1) * bb], h); } }
    out
}
pub fn flip_exact(h: u32) -> bool { h < 4 || h % 4 == 0 }

// ---- CPU decode ----
fn rgb565(c: u16) -> [u8; 3] {
    let (r, g, b) = (((c >> 11) & 31) as u32, ((c >> 5) & 63) as u32, (c & 31) as u32);
    [((r * 255 + 15) / 31) as u8, ((g * 255 + 31) / 63) as u8, ((b * 255 + 15) / 31) as u8]
}
fn bc1_colors(b: &[u8], four_always: bool) -> [[u8; 4]; 4] {
    let c0 = u16::from_le_bytes([b[0], b[1]]); let c1 = u16::from_le_bytes([b[2], b[3]]);
    let (a, c) = (rgb565(c0), rgb565(c1));
    let mix = |x: u8, y: u8, wx: u32, wy: u32, d: u32| ((x as u32 * wx + y as u32 * wy) / d) as u8;
    let mut t = [[a[0], a[1], a[2], 255], [c[0], c[1], c[2], 255], [0; 4], [0; 4]];
    if c0 > c1 || four_always {
        for k in 0..3 { t[2][k] = mix(a[k], c[k], 2, 1, 3); t[3][k] = mix(a[k], c[k], 1, 2, 3); }
        t[2][3] = 255; t[3][3] = 255;
    } else {
        for k in 0..3 { t[2][k] = mix(a[k], c[k], 1, 1, 2); }
        t[2][3] = 255; t[3] = [0, 0, 0, 0];
    }
    t
}
fn alpha_block(b: &[u8]) -> [u8; 16] {
    let (e0, e1) = (b[0] as u32, b[1] as u32);
    let mut pal = [0u8; 8]; pal[0] = e0 as u8; pal[1] = e1 as u8;
    if e0 > e1 { for i in 1..7u32 { pal[1 + i as usize] = (((7 - i) * e0 + i * e1) / 7) as u8; } }
    else { for i in 1..5u32 { pal[1 + i as usize] = (((5 - i) * e0 + i * e1) / 5) as u8; } pal[6] = 0; pal[7] = 255; }
    let mut bits = 0u64; for i in 0..6 { bits |= (b[2 + i] as u64) << (8 * i); }
    let mut o = [0u8; 16]; for i in 0..16 { o[i] = pal[((bits >> (3 * i)) & 7) as usize]; } o
}
/// Decode one mip to RGBA8 (row 0 = first stored row; `flip` reverses rows afterwards = exact for any h). BC7 -> Err (no CPU decoder).
pub fn decode_rgba8(f: Bc, rgb_only: bool, w: u32, h: u32, data: &[u8], flip: bool) -> Result<Vec<u8>, String> {
    if f == Bc::Bc7 { return Err("BC7 CPU decode not implemented".into()); }
    if data.len() != mip_bytes(f, w, h) { return Err(format!("BC data {} bytes != {}x{} mip ({})", data.len(), w, h, mip_bytes(f, w, h))); }
    let (bw, bh) = blocks(w, h); let bb = block_bytes(f);
    let mut out = vec![0u8; (w * h * 4) as usize];
    for by in 0..bh { for bx in 0..bw {
        let b = &data[(by * bw + bx) as usize * bb..][..bb];
        let mut px = [[0u8; 4]; 16];
        match f {
            Bc::Bc1 => { let t = bc1_colors(b, false); let idx = u32::from_le_bytes([b[4], b[5], b[6], b[7]]); for i in 0..16 { px[i] = t[((idx >> (2 * i)) & 3) as usize]; if rgb_only { px[i][3] = 255; } } }
            Bc::Bc2 => { let t = bc1_colors(&b[8..], true); let idx = u32::from_le_bytes([b[12], b[13], b[14], b[15]]); let al = u64::from_le_bytes(b[0..8].try_into().unwrap());
                for i in 0..16 { px[i] = t[((idx >> (2 * i)) & 3) as usize]; let a = ((al >> (4 * i)) & 15) as u8; px[i][3] = a * 17; } }
            Bc::Bc3 => { let t = bc1_colors(&b[8..], true); let idx = u32::from_le_bytes([b[12], b[13], b[14], b[15]]); let a = alpha_block(&b[0..8]);
                for i in 0..16 { px[i] = t[((idx >> (2 * i)) & 3) as usize]; px[i][3] = a[i]; } }
            Bc::Bc4 => { let r = alpha_block(&b[0..8]); for i in 0..16 { px[i] = [r[i], 0, 0, 255]; } }
            Bc::Bc5 => { let r = alpha_block(&b[0..8]); let g = alpha_block(&b[8..16]); for i in 0..16 { px[i] = [r[i], g[i], 0, 255]; } }
            Bc::Bc7 => unreachable!(),
        }
        for i in 0..16u32 { let (x, y) = (bx * 4 + i % 4, by * 4 + i / 4); if x < w && y < h { let yy = if flip { h - 1 - y } else { y }; out[((yy * w + x) * 4) as usize..][..4].copy_from_slice(&px[i as usize]); } }
    } }
    Ok(out)
}
/// BC1 RGB (DXT1 w/o alpha) with any 3-colour block that selects index 3: GPU BC1 samples alpha 0 there, GL RGB_S3TC_DXT1 / three sample opaque black -> caller decodes on CPU.
pub fn bc1_has_punchthrough(data: &[u8]) -> bool {
    data.chunks_exact(8).any(|b| { let c0 = u16::from_le_bytes([b[0], b[1]]); let c1 = u16::from_le_bytes([b[2], b[3]]); c0 <= c1 && b[4..8].iter().any(|&x| (0..4).any(|k| (x >> (2 * k)) & 3 == 3)) })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bc1(c0: u16, c1: u16, idx: u32) -> Vec<u8> { let mut v = c0.to_le_bytes().to_vec(); v.extend(c1.to_le_bytes()); v.extend(idx.to_le_bytes()); v }
    #[test] fn bc1_solid_red_and_blue() {
        let red = bc1(0xF800, 0x0000, 0); // index 0 everywhere = c0
        let px = decode_rgba8(Bc::Bc1, true, 4, 4, &red, false).unwrap();
        assert!(px.chunks(4).all(|p| p == [255, 0, 0, 255]));
        let blue = bc1(0x001F, 0x0000, 0);
        assert!(decode_rgba8(Bc::Bc1, false, 4, 4, &blue, false).unwrap().chunks(4).all(|p| p == [0, 0, 255, 255]));
    }
    #[test] fn bc1_interpolates_and_punchthrough() {
        // c0 white > c1 black: idx 2 = 2/3 white (170), idx 3 = 1/3 (85)
        let b = bc1(0xFFFF, 0x0000, 0b11_10_01_00);
        let px = decode_rgba8(Bc::Bc1, false, 4, 4, &b, false).unwrap();
        assert_eq!(&px[0..4], &[255, 255, 255, 255]); assert_eq!(&px[4..8], &[0, 0, 0, 255]); assert_eq!(&px[8..12], &[170, 170, 170, 255]); assert_eq!(&px[12..16], &[85, 85, 85, 255]);
        // c0 <= c1 -> 3-colour: idx 3 = transparent black (RGBA) / opaque (rgb_only)
        let t = bc1(0x0000, 0xFFFF, 0b11_10_01_00);
        assert_eq!(&decode_rgba8(Bc::Bc1, false, 4, 4, &t, false).unwrap()[12..16], &[0, 0, 0, 0]);
        assert_eq!(&decode_rgba8(Bc::Bc1, true, 4, 4, &t, false).unwrap()[12..16], &[0, 0, 0, 255]);
        assert!(bc1_has_punchthrough(&t)); assert!(!bc1_has_punchthrough(&b));
    }
    #[test] fn bc3_alpha_and_bc2_alpha() {
        let mut b3 = vec![128u8, 128, 0, 0, 0, 0, 0, 0]; b3.extend(bc1(0x07E0, 0, 0)); // alpha ep 128,128 idx0 -> 128 ; green
        let px = decode_rgba8(Bc::Bc3, false, 4, 4, &b3, false).unwrap();
        assert!(px.chunks(4).all(|p| p == [0, 255, 0, 128]));
        let mut b2 = vec![0xFFu8; 8]; b2.extend(bc1(0xF800, 0, 0)); // alpha nibble 15 -> 255
        assert!(decode_rgba8(Bc::Bc2, false, 4, 4, &b2, false).unwrap().chunks(4).all(|p| p == [255, 0, 0, 255]));
    }
    #[test] fn bc4_bc5_channels() {
        let r = vec![200u8, 200, 0, 0, 0, 0, 0, 0];
        assert!(decode_rgba8(Bc::Bc4, false, 4, 4, &r, false).unwrap().chunks(4).all(|p| p == [200, 0, 0, 255]));
        let mut rg = r.clone(); rg.extend([50u8, 50, 0, 0, 0, 0, 0, 0]);
        assert!(decode_rgba8(Bc::Bc5, false, 4, 4, &rg, false).unwrap().chunks(4).all(|p| p == [200, 50, 0, 255]));
    }
    #[test] fn block_flip_matches_pixel_flip() {
        // BC1 with 4 distinct rows (idx rows 0,1,2,3 -> colours c0, c1, 2/3, 1/3): flipping the compressed mip == flipping the decoded pixels
        let b = bc1(0xFFFF, 0x0000, 0b11_11_11_11_10_10_10_10_01_01_01_01_00_00_00_00);
        let a = decode_rgba8(Bc::Bc1, false, 4, 4, &b, true).unwrap();
        let c = decode_rgba8(Bc::Bc1, false, 4, 4, &flip_mip(Bc::Bc1, 4, 4, &b), false).unwrap();
        assert_eq!(a, c);
        // BC3 alpha ramp rows: rows use idx 0,2,4,6 of an 8-entry palette -> flip equality too
        let mut al = vec![255u8, 0]; let rows = [0u64, 1, 2, 7]; let mut bits = 0u64; for (r, v) in rows.iter().enumerate() { for c in 0..4 { bits |= v << (3 * (r * 4 + c)); } }
        for i in 0..6 { al.push((bits >> (8 * i)) as u8); } al.extend(bc1(0xFFFF, 0, 0));
        let a = decode_rgba8(Bc::Bc3, false, 4, 4, &al, true).unwrap();
        let c = decode_rgba8(Bc::Bc3, false, 4, 4, &flip_mip(Bc::Bc3, 4, 4, &al), false).unwrap();
        assert_eq!(a, c);
        // 8x8 two block rows: block-row order reverses too
        let mut big = Vec::new(); for k in 0..4u32 { big.extend(bc1(0xF800 >> (k % 2) * 0, 0, if k < 2 { 0 } else { 0xFFFF_FFFF })); }
        let a = decode_rgba8(Bc::Bc1, false, 8, 8, &big, true).unwrap();
        let c = decode_rgba8(Bc::Bc1, false, 8, 8, &flip_mip(Bc::Bc1, 8, 8, &big), false).unwrap();
        assert_eq!(a, c);
    }
    #[test] fn flip_small_mip_reverses_only_real_rows() {
        // 4x2 mip inside one block: rows 0,1 swap, rows 2,3 (padding) untouched
        let b = bc1(0xFFFF, 0x0000, 0b00_00_00_00_00_00_00_00_01_01_01_01_00_00_00_00 | (0b10 << 16));
        let a = decode_rgba8(Bc::Bc1, false, 4, 2, &b, true).unwrap();
        let c = decode_rgba8(Bc::Bc1, false, 4, 2, &flip_mip(Bc::Bc1, 4, 2, &b), false).unwrap();
        assert_eq!(a, c);
    }
    #[test] fn mip_sizes_and_gl_table() {
        assert_eq!(mip_bytes(Bc::Bc1, 1, 1), 8); assert_eq!(mip_bytes(Bc::Bc3, 9, 5), 3 * 2 * 16);
        assert_eq!(from_gl(33776), Some((Bc::Bc1, true))); assert_eq!(from_gl(33779), Some((Bc::Bc3, false))); assert_eq!(from_gl(36284), None);
    }
}
