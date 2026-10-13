// vista2glb: group-aware vista OBJ (g <mesh> blocks, global v/f idx) -> GLB, flat-shaded (unwelded face normals), 2 materials.
// usage: vista2glb in.obj out.glb hashes.txt mountainKeep groundKeep   (hashes.txt = cross-file dedup, appended)
// per block: ocean planes (name oceanwaterplane | flat y<192.2) DROPPED; world/terrain/* non-ship = mountain (#6f7a6a, simplify to mountainKeep);
// vista_*_quadrant_* tiles whose bbox centre lies inside the city/mpr cores are DROPPED (redundant proxies of real map geometry), else ground (#8a8f86, groundKeep); rest = ground.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <cmath>
#include <vector>
#include <string>
#include <set>
#include <algorithm>
#include <fstream>
#include <sstream>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include "meshoptimizer.h"
using namespace std;
struct Block { string name; vector<uint32_t> tris; };
struct Prim { vector<float> pos, nrm; };
static float lin(int c) { float s = c / 255.f; return s <= 0.04045f ? s / 12.92f : powf((s + 0.055f) / 1.055f, 2.4f); }
static bool inCore(float x, float z) {
  const float c[2][4] = {{-237.6f, 988.4f, 984.f, 1998.7f}, {-123.4f, -669.8f, 405.3f, -241.5f}};
  for (auto& r : c) if (x > r[0] - 30 && x < r[2] + 30 && z > r[1] - 30 && z < r[3] + 30) return true;
  return false;
}
static void emit(Prim& P, const vector<float>& pos, const vector<uint32_t>& idx) {
  for (size_t t = 0; t + 2 < idx.size(); t += 3) {
    const float *a = &pos[idx[t]*3], *b = &pos[idx[t+1]*3], *c = &pos[idx[t+2]*3];
    float u[3] = {b[0]-a[0], b[1]-a[1], b[2]-a[2]}, v[3] = {c[0]-a[0], c[1]-a[1], c[2]-a[2]};
    float n[3] = {u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]};
    float l = sqrtf(n[0]*n[0]+n[1]*n[1]+n[2]*n[2]); if (l < 1e-12f) continue;
    for (int k = 0; k < 3; k++) n[k] /= l;
    for (int j = 0; j < 3; j++) { const float* p = &pos[idx[t+j]*3]; P.pos.insert(P.pos.end(), p, p+3); P.nrm.insert(P.nrm.end(), n, n+3); }
  }
}
int main(int argc, char** argv) {
  if (argc < 6) { fprintf(stderr, "usage\n"); return 1; }
  float mk = atof(argv[4]), gk = atof(argv[5]);
  set<string> seen; { ifstream h(argv[3]); string s; while (getline(h, s)) seen.insert(s); }
  ofstream hout(argv[3], ios::app);
  int fd = open(argv[1], O_RDONLY); struct stat st; fstat(fd, &st);
  const char* p = (const char*)mmap(0, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0); const char* end = p + st.st_size;
  vector<float> V; vector<Block> B;
  while (p < end) {
    const char* nl = (const char*)memchr(p, '\n', end - p); if (!nl) nl = end;
    if (p[0]=='g' && p[1]==' ') { B.push_back({string(p+2, nl-p-2), {}}); }
    else if (p[0]=='v' && p[1]==' ') { char* q; float a = strtof(p+2,&q), b = strtof(q,&q), c = strtof(q,&q); V.push_back(a); V.push_back(b); V.push_back(c); }
    else if (p[0]=='f' && p[1]==' ' && !B.empty()) { char* q; long a = strtol(p+2,&q,10), b = strtol(q,&q,10), c = strtol(q,&q,10); auto& T = B.back().tris; T.push_back(a-1); T.push_back(b-1); T.push_back(c-1); }
    p = nl + 1;
  }
  fprintf(stderr, "parsed %zu verts, %zu blocks\n", V.size()/3, B.size());
  Prim M, G; size_t inT = 0, dropOcean = 0, dropDup = 0, dropCore = 0, dropShard = 0, nM = 0, nG = 0;
  for (auto& b : B) {
    if (b.tris.empty()) continue;
    inT += b.tris.size()/3;
    float mn[3] = {1e30f,1e30f,1e30f}, mx[3] = {-1e30f,-1e30f,-1e30f};
    for (auto i : b.tris) for (int k = 0; k < 3; k++) { float v = V[i*3+k]; mn[k] = min(mn[k], v); mx[k] = max(mx[k], v); }
    bool ocean = b.name.find("oceanwaterplane") != string::npos || (mx[1] < 192.2f && mx[1]-mn[1] < 0.5f);
    if (ocean) { dropOcean += b.tris.size()/3; continue; }
    char hk[512]; snprintf(hk, sizeof hk, "%s|%.0f,%.0f,%.0f,%.0f,%.0f,%.0f|%zu", b.name.c_str(), mn[0],mn[1],mn[2],mx[0],mx[1],mx[2], b.tris.size()/3);
    if (seen.count(hk)) { dropDup += b.tris.size()/3; continue; }
    seen.insert(hk); hout << hk << "\n";
    bool ship = b.name.find("vista_ship") != string::npos;
    bool quad = b.name.find("_quadrant_") != string::npos;
    bool mountain = b.name.find("world/terrain/") == 0 && !ship;
    if (quad && inCore((mn[0]+mx[0])/2, (mn[2]+mx[2])/2)) { dropCore += b.tris.size()/3; continue; }
    // shard filter: the extractor emits a few % corrupt/stretched tris (edges km long) -> drop tris whose longest edge > 6x the block's p90 edge (floor 100 m)
    {
      vector<float> el; vector<float> mxe(b.tris.size()/3);
      for (size_t t = 0; t < b.tris.size(); t += 3) { float m = 0; for (int j = 0; j < 3; j++) { const float *u = &V[b.tris[t+j]*3], *w = &V[b.tris[t+(j+1)%3]*3]; float d = sqrtf((u[0]-w[0])*(u[0]-w[0])+(u[1]-w[1])*(u[1]-w[1])+(u[2]-w[2])*(u[2]-w[2])); el.push_back(d); m = max(m, d); } mxe[t/3] = m; }
      sort(el.begin(), el.end()); float lim = max(100.f, 6.f * el[(size_t)(el.size() * 0.9)]);
      vector<uint32_t> k; for (size_t t = 0; t < mxe.size(); t++) if (mxe[t] <= lim) k.insert(k.end(), b.tris.begin()+t*3, b.tris.begin()+t*3+3); else dropShard++;
      b.tris.swap(k); if (b.tris.empty()) continue;
    }
    // local compact + weld
    vector<uint32_t> remap(b.tris.size()); vector<float> lp;
    { vector<float> tmp; tmp.reserve(b.tris.size()*3); for (auto i : b.tris) tmp.insert(tmp.end(), &V[i*3], &V[i*3]+3);
      size_t nu = meshopt_generateVertexRemap(remap.data(), nullptr, b.tris.size(), tmp.data(), b.tris.size(), 12);
      lp.resize(nu*3); meshopt_remapVertexBuffer(lp.data(), tmp.data(), b.tris.size(), 12, remap.data()); }
    vector<uint32_t> idx = remap;
    float keep = mountain ? mk : (ship ? 1.f : gk);
    if (keep < 0.999f) {
      size_t target = max<size_t>(36, (size_t)(idx.size()*keep)/3*3); vector<uint32_t> out(idx.size()); float re = 0;
      size_t n = meshopt_simplify(out.data(), idx.data(), idx.size(), lp.data(), lp.size()/3, 12, target, mountain ? 0.02f : 0.05f, meshopt_SimplifyLockBorder, &re);
      out.resize(n); idx.swap(out);
    }
    emit(mountain ? M : G, lp, idx); (mountain ? nM : nG) += idx.size()/3;
  }
  fprintf(stderr, "in %zu tris; dropped ocean %zu dup %zu core-quadrant %zu shard %zu; out mountain %zu ground %zu\n", inT, dropOcean, dropDup, dropCore, dropShard, nM, nG);
  // GLB: 2 prims (mountain mat0, ground mat1), POSITION+NORMAL non-indexed
  vector<Prim*> prims; if (!M.pos.empty()) prims.push_back(&M); if (!G.pos.empty()) prims.push_back(&G);
  if (prims.empty()) { fprintf(stderr, "nothing to write\n"); return 2; }
  string acc, bv, pr; size_t off = 0; int ai = 0;
  vector<int> matOf; for (auto* x : prims) matOf.push_back(x == &M ? 0 : 1);
  for (size_t k = 0; k < prims.size(); k++) {
    auto& P = *prims[k]; size_t nv = P.pos.size()/3; float mn[3] = {1e30f,1e30f,1e30f}, mx[3] = {-1e30f,-1e30f,-1e30f};
    for (size_t i = 0; i < nv; i++) for (int c = 0; c < 3; c++) { mn[c] = min(mn[c], P.pos[i*3+c]); mx[c] = max(mx[c], P.pos[i*3+c]); }
    char b[1024];
    snprintf(b, sizeof b, "%s{\"bufferView\":%d,\"componentType\":5126,\"count\":%zu,\"type\":\"VEC3\",\"min\":[%f,%f,%f],\"max\":[%f,%f,%f]},{\"bufferView\":%d,\"componentType\":5126,\"count\":%zu,\"type\":\"VEC3\"}", acc.empty()?"":",", (int)k*2, nv, mn[0],mn[1],mn[2],mx[0],mx[1],mx[2], (int)k*2+1, nv); acc += b;
    snprintf(b, sizeof b, "%s{\"buffer\":0,\"byteOffset\":%zu,\"byteLength\":%zu,\"target\":34962},{\"buffer\":0,\"byteOffset\":%zu,\"byteLength\":%zu,\"target\":34962}", bv.empty()?"":",", off, nv*12, off+nv*12, nv*12); bv += b; off += nv*24;
    snprintf(b, sizeof b, "%s{\"attributes\":{\"POSITION\":%d,\"NORMAL\":%d},\"material\":%d}", pr.empty()?"":",", (int)k*2, (int)k*2+1, matOf[k]); pr += b;
  }
  char mats[1024]; snprintf(mats, sizeof mats, "[{\"name\":\"mountain\",\"doubleSided\":true,\"pbrMetallicRoughness\":{\"baseColorFactor\":[%f,%f,%f,1],\"metallicFactor\":0,\"roughnessFactor\":1}},{\"name\":\"ground\",\"doubleSided\":true,\"pbrMetallicRoughness\":{\"baseColorFactor\":[%f,%f,%f,1],\"metallicFactor\":0,\"roughnessFactor\":1}}]", lin(0x6f),lin(0x7a),lin(0x6a), lin(0x8a),lin(0x8f),lin(0x86));
  string json = string("{\"asset\":{\"version\":\"2.0\",\"generator\":\"vista2glb\"},\"scene\":0,\"scenes\":[{\"nodes\":[0]}],\"nodes\":[{\"mesh\":0}],\"materials\":") + mats + ",\"meshes\":[{\"primitives\":[" + pr + "]}],\"accessors\":[" + acc + "],\"bufferViews\":[" + bv + "],\"buffers\":[{\"byteLength\":" + to_string(off) + "}]}";
  while (json.size() % 4) json += ' ';
  uint32_t total = 12 + 8 + json.size() + 8 + off;
  FILE* f = fopen(argv[2], "wb"); uint32_t hdr[3] = {0x46546C67, 2, total}; fwrite(hdr, 4, 3, f);
  uint32_t jh[2] = {(uint32_t)json.size(), 0x4E4F534A}; fwrite(jh, 4, 2, f); fwrite(json.data(), 1, json.size(), f);
  uint32_t bh[2] = {(uint32_t)off, 0x004E4942}; fwrite(bh, 4, 2, f);
  for (auto* x : prims) { fwrite(x->pos.data(), 4, x->pos.size(), f); fwrite(x->nrm.data(), 4, x->nrm.size(), f); }
  fclose(f); fprintf(stderr, "wrote %s %.1f MB\n", argv[2], total/1e6);
  return 0;
}
