#!/usr/bin/env python3
"""
vroid_master.py — reference reader/writer for the VRoid `.vroid` master format.

`.vroid` = ZIP { meta.json, v1model/meta.json, v1model/data.bin, thumbnails/... }
`v1model/data.bin` = a standard protobuf message.

This module provides a LOSSLESS shallow protobuf transcoder (wire-2 payloads kept
as raw bytes, only parsed on demand along an edit path), plus slider read/write.

Slider value location (see VROID-MASTER-FORMAT-SPEC.md §4.1):
  top.field4[slot]  (field2 == "TransferableType.N00.<Part>")
    .field3
      .field5
        .field2[param]  { field1: shortName, field2: f32 value }   # 0.0 omitted
Group map (top.field5[].field5[]) gives catalogKey <-> shortName.
"""
import struct, zipfile, io, os

# ---------- wire primitives ----------
def read_varint(b, p):
    r = s = 0
    while True:
        c = b[p]; r |= (c & 0x7f) << s; p += 1; s += 7
        if not c & 0x80:
            return r, p

def write_varint(v):
    out = bytearray()
    while True:
        c = v & 0x7f; v >>= 7
        out.append(c | (0x80 if v else 0))
        if not v:
            return bytes(out)

# ---------- shallow message model ----------
class Msg:
    """Ordered list of (fnum, wtype, payload). payload: int(w0) | bytes(w1/w2/w5)."""
    def __init__(self, entries=None):
        self.entries = entries if entries is not None else []

    @classmethod
    def parse(cls, b):
        entries = []; p = 0; n = len(b)
        while p < n:
            key, p = read_varint(b, p)
            fnum, wt = key >> 3, key & 7
            if wt == 0:
                v, p = read_varint(b, p); entries.append((fnum, 0, v))
            elif wt == 1:
                entries.append((fnum, 1, b[p:p+8])); p += 8
            elif wt == 2:
                ln, p = read_varint(b, p); entries.append((fnum, 2, b[p:p+ln])); p += ln
            elif wt == 5:
                entries.append((fnum, 5, b[p:p+4])); p += 4
            else:
                raise ValueError(f"bad wiretype {wt} at {p}")
        return cls(entries)

    def serialize(self):
        out = bytearray()
        for fnum, wt, payload in self.entries:
            out += write_varint((fnum << 3) | wt)
            if wt == 0:
                out += write_varint(payload)
            elif wt in (1, 5):
                out += payload
            elif wt == 2:
                out += write_varint(len(payload)); out += payload
        return bytes(out)

    # helpers
    def get(self, fnum, idx=0):
        seen = 0
        for f, wt, pl in self.entries:
            if f == fnum:
                if seen == idx:
                    return wt, pl
                seen += 1
        return None, None

    def all(self, fnum):
        return [(wt, pl) for f, wt, pl in self.entries if f == fnum]

    def set_or_add(self, fnum, wt, payload):
        for i, (f, w, pl) in enumerate(self.entries):
            if f == fnum:
                self.entries[i] = (fnum, wt, payload); return
        self.entries.append((fnum, wt, payload))

# ---------- .vroid I/O ----------
def load_databin(vroid_path):
    return zipfile.ZipFile(vroid_path).read('v1model/data.bin')

def save_databin(src_vroid, dst_vroid, new_databin):
    zin = zipfile.ZipFile(src_vroid)
    if os.path.exists(dst_vroid):
        os.remove(dst_vroid)
    zout = zipfile.ZipFile(dst_vroid, 'w', zipfile.ZIP_DEFLATED)
    for info in zin.infolist():
        data = new_databin if info.filename == 'v1model/data.bin' else zin.read(info.filename)
        zout.writestr(info, data)
    zout.close(); zin.close()

# ---------- slider catalog + values ----------
def _txt(pl):
    try: return pl.decode('utf-8')
    except: return None

def build_short2key(top):
    """group (field5) -> {shortName: catalogKey}"""
    m = {}
    for wt, gp in top.all(5):
        g = Msg.parse(gp)
        for pwt, pp in g.all(5):            # param defs
            pm = Msg.parse(pp)
            _, keyb = pm.get(1)             # Level*Key
            _, subb = pm.get(3)
            if keyb and subb:
                _, snb = Msg.parse(subb).get(1)
                if snb:
                    m[_txt(snb)] = _txt(keyb)
    return m

def read_values(top):
    """-> {catalogKey: float} for all present sliders (0.0 if value omitted)."""
    short2key = build_short2key(top)
    out = {}
    for wt, sp in top.all(4):              # slots
        slot = Msg.parse(sp)
        _, f3 = slot.get(3)
        if not f3:
            continue
        f3m = Msg.parse(f3)
        _, f5 = f3m.get(5)
        if not f5:
            continue
        f5m = Msg.parse(f5)
        for pwt, pp in f5m.all(2):         # param value entries
            pm = Msg.parse(pp)
            _, nb = pm.get(1)
            if not nb:
                continue
            name = _txt(nb)
            vwt, vpl = pm.get(2)
            val = struct.unpack('<f', vpl)[0] if (vwt == 5 and vpl) else 0.0
            out[short2key.get(name, name)] = val
    return out

def set_value(top, catalog_key, value):
    """Set a slider by catalog key (creates the value field if it was default/omitted).
       Returns True if written. Rebuilds nested messages losslessly along the path."""
    short2key = build_short2key(top)
    key2short = {v: k for k, v in short2key.items()}
    short = key2short.get(catalog_key)
    if short is None:
        raise KeyError(f"unknown slider {catalog_key}")

    for si, (f, wt, sp) in enumerate(top.entries):
        if f != 4 or wt != 2:
            continue
        slot = Msg.parse(sp)
        _, f3 = slot.get(3)
        if not f3:
            continue
        f3m = Msg.parse(f3)
        f5wt, f5 = f3m.get(5)
        if not f5:
            continue
        f5m = Msg.parse(f5)
        changed = False
        for pi, (pf, pwt, pp) in enumerate(f5m.entries):
            if pf != 2 or pwt != 2:
                continue
            pm = Msg.parse(pp)
            _, nb = pm.get(1)
            if nb and _txt(nb) == short:
                pm.set_or_add(2, 5, struct.pack('<f', float(value)))
                f5m.entries[pi] = (2, 2, pm.serialize())
                changed = True
                break
        if changed:
            f3m.set_or_add(5, 2, f5m.serialize())
            slot.set_or_add(3, 2, f3m.serialize())
            top.entries[si] = (4, 2, slot.serialize())
            return True
    return False
