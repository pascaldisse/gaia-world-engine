# HANDOFF — 全容作戦 ②merge + ③opt-in試験世界 (lane: naru-opus / Vishnu / L2)

庭=`/Users/pascaldisse/projects/gwe-merge-vishnu` · branch=`main` · 主樹`GAIA-World-Engine`不触(rust-port のまま)
node_modules=主樹へのsymlink · `npm run build` 無し ∴ `npx vite build`

## ②merge — 畢
```
8259beb fluid: authored color through native material path
05b85d9 tools: varuna-eval/varuna-shot + plates
1b2bc76 fluid: cone wall + skyenv (scene.environment)
d38c13d truth: EMPTY偽コメント訂正 + worlds/**/saves/
1e4254b fluid: cylinder 拘束
30935e5 hygiene: worlds/saves 無視
3624f60 worlds/surya-optin (新file only)
5c10e0b merge feat/jareth-gpu-fluid ← 563814b
4fbb450 merge c1-primitives         ← cdc5fc4
fa44db0 親
```
conflict=**零**。重複file(`.gitignore`/`environment.js`/`server/index.js`)は両枝が同一cherry-pick ∴ 自動解決。
裁定一件: fluid枝 root `build.txt`=腐屍(中身2d00fc0=自枝HEADより古·読み手零)→**削除**。審で PASS。
beacon正典=`client/assets/build.txt` **一本のみ**。client変更commitは親hashを**commit前に**書く。root build.txt復活禁。

## 門 現況
| 門 | 判 | 據 |
|---|---|---|
| conflict記録·beacon儀式 | PASS | 上記 |
| vite build | PASS | `✓ 148 modules` |
| primitives test | PASS | 2/2 |
| attach · TTL · per-part phase | PASS(実測) | 実座標 / 60s消滅 / 三時刻scale `[1,1.2451]→[1,0.7532]→[1,1.2488]` |
| transmission(材) | PASS | 環境供給後、単色屈折を脱す |
| singleton · 親不在退避 · TTL永続非汚染 | PASS | 反証実験含む |
| Atlas非opt-in不変(fluid/skyenv) | PASS(実測) | `env:null, fluidSim:null, entities:57` |
| **box既定WGSL byte一致** | **PASS(実dump)** | 同一world dataで pre/post 7本 sha256全一致 |
| 脚本非(物理創発) | PASS(静的) | timer/keyframe零、`Math.random`は`seed()`のみ |
| 円錐壁が盆面に載る | PASS(実測) | `rmax=1.675` = `1.55+0.39·(0.8/2.4)` 完全一致、`outsideR=0` |
| **60fps門** | **FAIL** | 下記 GATE-FPS-1 |
| **流体真門(水に見える)** | **FAIL** | 液は平坦·揺らぎ無·離散の板、色が白飽和 |
| transmission強制廃止のAtlas影響 | UNVERIFIED | 当該世界にtransmissive材0本 ∴ 測れず。Atlas実data要 |
| Atlas見え pre/post plate差分 | UNVERIFIED | 未取得 |

## GATE-FPS-1 (審Yamaが定義·唯一の基準)
> rAF禁(vsync天井·occlusion throttleで汚染) · 可視Brave · **非headless** · 並走GPU仕事無し · 粒子数明記。
> 測るのは **`sim.step(1/60)` + `renderAsync`**、≥600frame。**合格 = p95 ≤ 16.7ms**(meanでなくp95)。

現HEAD `8259beb` 実測(静穏·16384粒·900frame·headful):
```
meanMs 15.55 (64.3fps) p50 15.9 p95 19.5 p99 22.6 max 51.1 framesOver16_7=324 (36%)
```
**FAIL**。内訳: render単体 **2.07ms** ∴ **`sim.step` ≈ 13.5ms = 支配項**。攻め場所=**compute**(iterations×(kLambda,kDelta,kApply) · cellsPerAxis/cellCapacity 48 · 27cell近傍走査 · atomic競合)。

## 死枝(屍·再訪禁)
- 「盆を越え爆散」= **偽**(`outsideR=0`)。真因は寸法不整合(円錐盆 vs 直円柱拘束)→ 修正済。
- 色の黄化: 硬子越し交絡説=死 · 被照射説(lights=false)=死 · 速度mix単独因=死 · toneMapping=死(0でも画素不変)。
  → 根因=`SpriteNodeMaterial.colorNode` 定数経路がsRGB変換を受けぬ。native `material.color` 経路へ。**回避であって修理でない**が engine側の正しい作法 ∴ 可。
- fps 121.55 / 59.3 / 35.8 の三値 = **機の混雑**(並走laneがGPUを奪う)。121は採取碼がrepoに無く**再現不能=UNVERIFIED**。rAF路では原理上出ぬ(天井60)。
- adapter `apple/metal-3` = **撤回·UNVERIFIED**。出所は`tools/beauty-look.mjs:81-85`の旧Atlas器の別世界出力であって流体tabの実出力に非ず。

## 未閉(次laneの仕事)
1. **60fps門**: `sim.step` 13.5ms を削る。物理を偽るな — 最適化の度に `ymax/ymean/rmax/outsideR` を再測して物理保全を示せ(前値 `ymax=0.800 ymean=0.387 rmax=1.675 outsideR=0`)。
2. **流体の見え**: 池中心 mean RGB **(189,209,224)≈白**(期待≈(159,212,255))。筆頭仮説=**16384枚半透明sprite重畳の飽和**(blending/premultiplied alpha/depthWrite も見よ)= UNVERIFIED。
3. **`speedColorMix` 既定0 は不可**(裁定済)。速度で色が変わる表現を既定で殺している → 既定を戻す。色管理修正と表現削除を同commitで抱き合わせたのが罪。
4. transmission強制廃止のAtlas実data検証 · Atlas見えpre/post plate差分。

## 法(この作戦で身に沁みた分)
- **headless厳禁**。あるlaneが「可視Brave」と報じたが `ps` に `--headless=new` が出た=誑。以後**測定は`headless:false`を実出力で証してから貼る**。
- **並列は測定を汚す**。fps採取は静穏下で直列化。自lane発のBrave/viteは必ず落とす(あるlaneが52process残し他の測定を汚した)。
- 目視語を実測と偽るな。断言は再現手順(採取碼)ごと出せ。repoに無い採取碼の数値=UNVERIFIED。
- 死枝は理由ごと残す(上記)。
