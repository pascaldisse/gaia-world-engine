// obj2glb: OBJ (v/f only, global idx) -> filter to playable bbox -> weld -> meshopt simplify -> GLB (pos+idx, grey mat)
// usage: obj2glb in.obj minx miny minz maxx maxy maxz ratio error out.glb [lodRatio lodError lod.glb]
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <vector>
#include <string>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include "meshoptimizer.h"
using namespace std;

static void writeGlb(const char* path, const vector<float>& pos, const vector<uint32_t>& idx) {
  size_t nv = pos.size() / 3;
  float mn[3] = {1e30f, 1e30f, 1e30f}, mx[3] = {-1e30f, -1e30f, -1e30f};
  for (size_t i = 0; i < nv; i++) for (int k = 0; k < 3; k++) { float v = pos[i*3+k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  size_t posBytes = nv * 12, idxBytes = idx.size() * 4;
  char json[2048];
  int jl = snprintf(json, sizeof json,
    "{\"asset\":{\"version\":\"2.0\",\"generator\":\"obj2glb\"},\"scene\":0,\"scenes\":[{\"nodes\":[0]}],\"nodes\":[{\"mesh\":0}],"
    "\"materials\":[{\"name\":\"grey\",\"doubleSided\":true,\"pbrMetallicRoughness\":{\"baseColorFactor\":[0.62,0.62,0.64,1],\"metallicFactor\":0,\"roughnessFactor\":1}}],"
    "\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":0},\"indices\":1,\"material\":0}]}],"
    "\"accessors\":[{\"bufferView\":0,\"componentType\":5126,\"count\":%zu,\"type\":\"VEC3\",\"min\":[%f,%f,%f],\"max\":[%f,%f,%f]},"
    "{\"bufferView\":1,\"componentType\":5125,\"count\":%zu,\"type\":\"SCALAR\"}],"
    "\"bufferViews\":[{\"buffer\":0,\"byteOffset\":0,\"byteLength\":%zu,\"target\":34962},{\"buffer\":0,\"byteOffset\":%zu,\"byteLength\":%zu,\"target\":34963}],"
    "\"buffers\":[{\"byteLength\":%zu}]}",
    nv, mn[0], mn[1], mn[2], mx[0], mx[1], mx[2], idx.size(), posBytes, posBytes, idxBytes, posBytes + idxBytes);
  while (jl % 4) json[jl++] = ' ';
  size_t binLen = posBytes + idxBytes;
  uint32_t total = 12 + 8 + jl + 8 + binLen;
  FILE* f = fopen(path, "wb");
  uint32_t hdr[3] = {0x46546C67, 2, total}; fwrite(hdr, 4, 3, f);
  uint32_t jh[2] = {(uint32_t)jl, 0x4E4F534A}; fwrite(jh, 4, 2, f); fwrite(json, 1, jl, f);
  uint32_t bh[2] = {(uint32_t)binLen, 0x004E4942}; fwrite(bh, 4, 2, f);
  fwrite(pos.data(), 1, posBytes, f); fwrite(idx.data(), 1, idxBytes, f);
  fclose(f);
  fprintf(stderr, "wrote %s: %zu verts %zu tris %.1f MB bbox [%.1f %.1f %.1f]..[%.1f %.1f %.1f]\n", path, nv, idx.size()/3, total/1e6, mn[0],mn[1],mn[2],mx[0],mx[1],mx[2]);
}

// simplify (pos, idx) to ratio; returns compacted result
static void simplifyTo(vector<float>& pos, vector<uint32_t>& idx, float ratio, float err) {
  size_t target = (size_t)(idx.size() * ratio) / 3 * 3;
  vector<uint32_t> out(idx.size());
  float resErr = 0;
  size_t n = meshopt_simplify(out.data(), idx.data(), idx.size(), pos.data(), pos.size()/3, 12, target, err, meshopt_SimplifySparse | (getenv("NOPRUNE") ? 0 : meshopt_SimplifyPrune), &resErr);
  out.resize(n);
  if (getenv("SLOPPY") && n > target * 1.15) {
    vector<uint32_t> o2(n);
    size_t n2 = meshopt_simplifySloppy(o2.data(), out.data(), n, pos.data(), pos.size()/3, 12, target, 1.0f, &resErr);
    o2.resize(n2); out.swap(o2); n = n2;
    fprintf(stderr, "sloppy -> %zu idx err %.5f\n", n2, resErr);
  }
  fprintf(stderr, "simplify: %zu -> %zu idx (target %zu) resultError %.5f\n", idx.size(), n, target, resErr);
  // compact verts
  vector<uint32_t> remap(pos.size()/3, ~0u); vector<float> np; np.reserve(n*3/2);
  for (auto& i : out) { if (remap[i] == ~0u) { remap[i] = np.size()/3; np.insert(np.end(), pos.begin()+i*3, pos.begin()+i*3+3); } i = remap[i]; }
  pos.swap(np); idx.swap(out);
  meshopt_optimizeVertexCache(idx.data(), idx.data(), idx.size(), pos.size()/3);
}

int main(int argc, char** argv) {
  if (argc < 11) { fprintf(stderr, "usage\n"); return 1; }
  float bmin[3] = {(float)atof(argv[2]), (float)atof(argv[3]), (float)atof(argv[4])}, bmax[3] = {(float)atof(argv[5]), (float)atof(argv[6]), (float)atof(argv[7])};
  float ratio = atof(argv[8]), err = atof(argv[9]);
  int fd = open(argv[1], O_RDONLY); struct stat st; fstat(fd, &st);
  const char* p = (const char*)mmap(0, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0); const char* end = p + st.st_size;
  vector<float> V; V.reserve(40000000ull * 3); vector<uint32_t> F; F.reserve(36000000ull * 3);
  while (p < end) {
    const char* nl = (const char*)memchr(p, '\n', end - p); if (!nl) nl = end;
    if (p[0] == 'v' && p[1] == ' ') { char* q; float a = strtof(p+2, &q), b = strtof(q, &q), c = strtof(q, &q); V.push_back(a); V.push_back(b); V.push_back(c); }
    else if (p[0] == 'f' && p[1] == ' ') { char* q; long a = strtol(p+2, &q, 10), b = strtol(q, &q, 10), c = strtol(q, &q, 10); F.push_back(a-1); F.push_back(b-1); F.push_back(c-1); }
    p = nl + 1;
  }
  fprintf(stderr, "parsed %zu verts %zu tris\n", V.size()/3, F.size()/3);
  // filter by centroid in bbox
  vector<uint32_t> keep; keep.reserve(F.size());
  for (size_t t = 0; t < F.size(); t += 3) {
    float c[3] = {0,0,0};
    for (int j = 0; j < 3; j++) for (int k = 0; k < 3; k++) c[k] += V[F[t+j]*3+k] / 3;
    if (c[0]<bmin[0]||c[1]<bmin[1]||c[2]<bmin[2]||c[0]>bmax[0]||c[1]>bmax[1]||c[2]>bmax[2]) continue;
    keep.push_back(F[t]); keep.push_back(F[t+1]); keep.push_back(F[t+2]);
  }
  fprintf(stderr, "kept %zu tris after bbox filter\n", keep.size()/3);
  vector<uint32_t>().swap(F);
  // weld: remap over the kept-index set
  size_t nvAll = V.size()/3;
  vector<uint32_t> remap(nvAll);
  size_t nu = meshopt_generateVertexRemap(remap.data(), keep.data(), keep.size(), V.data(), nvAll, 12);
  vector<uint32_t> idx(keep.size()); meshopt_remapIndexBuffer(idx.data(), keep.data(), keep.size(), remap.data());
  vector<float> pos(nu*3); meshopt_remapVertexBuffer(pos.data(), V.data(), nvAll, 12, remap.data());
  vector<float>().swap(V); vector<uint32_t>().swap(keep); vector<uint32_t>().swap(remap);
  // drop degenerate
  size_t w = 0; for (size_t t = 0; t < idx.size(); t += 3) if (idx[t]!=idx[t+1]&&idx[t+1]!=idx[t+2]&&idx[t]!=idx[t+2]) { idx[w++]=idx[t]; idx[w++]=idx[t+1]; idx[w++]=idx[t+2]; }
  idx.resize(w);
  fprintf(stderr, "welded: %zu verts %zu tris\n", nu, idx.size()/3);
  simplifyTo(pos, idx, ratio, err);
  writeGlb(argv[10], pos, idx);
  if (argc >= 14) { simplifyTo(pos, idx, atof(argv[11]), atof(argv[12])); writeGlb(argv[13], pos, idx); }
  return 0;
}
