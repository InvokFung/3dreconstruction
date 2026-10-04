# recon: photos/video to a textured 3D model

`recon` is the reconstruction pipeline behind the web app. The worker runs it as a subprocess:

```bash
cd backend
python -m recon.cli --job-dir /data/jobs/<id> --config /data/jobs/<id>/config.json
python -m recon.cli --capabilities          # one JSON object: which engines can run here
python -m recon.cli --download-models       # pre-fetch all weights into $RECON_MODEL_DIR
```

The interface is defined by `docs/ARCHITECTURE.md` section 1. Inputs are read from
`<job>/input/`, outputs are written to `<job>/output/`, stdout carries JSON Lines only, and
progress is monotonic. Error codes are `too_few_images`, `too_few_registered`, `no_subject_found`,
`out_of_memory`, `unsupported_input`, `engine_unavailable` and `internal`. The CLI duplicates fd 1
at startup and points fd 1 at stderr, so native libraries that print to stdout cannot corrupt the
protocol. SIGTERM/SIGINT are received on a dedicated thread with `sigwait`, so cancellation works
even while COLMAP, torch or Open3D are busy in native code. Native COLMAP work is cancelled
through a `pycolmap.CancellationToken`. The process exits with code 143 within about 2 s, or is
hard-killed after 5 s.

## Install

```bash
python3.11 -m venv /opt/venvs/recon && . /opt/venvs/recon/bin/activate
pip install -r backend/recon/requirements.txt
pip install --no-deps -r backend/recon/requirements-nodeps.txt
apt-get install -y libgl1 libegl1 libgomp1            # Open3D runtime libraries
python -m recon.cli --download-models                 # ~3.5 GB; optional (otherwise lazy)
```

Weights are cached under `RECON_MODEL_DIR` (default `~/.cache/recon`). The CLI points `HF_HOME`
and `TORCH_HOME` there. Tests: `cd backend/recon && pytest -m "not slow"` takes about 15 s.
`pytest` runs everything, including the end-to-end tests on `samples/`, which take several minutes.

## Pipeline (engine `photogrammetry`, default, CPU-capable)

| stage | what happens |
|---|---|
| ingest | Photos (JPG/PNG/WebP/HEIC, EXIF orientation applied) and videos. For videos, the timeline is split into N bins (40/80/120 by preset) and the sharpest frame of each bin is kept. Exact and near-duplicate frames and very blurry photos are dropped. Images are downscaled to a quality-dependent maximum side. A focal-length prior comes from EXIF `FocalLengthIn35mmFilm`. Ordering uses the EXIF capture time when every photo has one, otherwise file names in natural order. |
| masking (object mode) | BiRefNet-lite (MIT) segments the subject in every image. Masks are cleaned (main blobs kept, small holes filled), then undistorted with the cameras. Fails with `no_subject_found` when most images contain no clear subject. |
| sfm | ALIKED-N16rot keypoints plus LightGlue (kornia) are written into a COLMAP database, verified geometrically by COLMAP and passed to the COLMAP 4.2 incremental mapper; the largest model is kept. **Pair selection:** if consecutive photos match strongly, the capture is treated as ordered and pairs are added by increasing index offset (cyclic, so orbits close). This stops when the median match count drops, which avoids "doppelganger" pairs between symmetric views. Large sets (video) use a sequential window plus DINOv2 retrieval. If the learned matcher cannot load, COLMAP SIFT is used instead. A relaxed second mapping pass runs if registration is below 70%. |
| depth | **Depth Anything 3** (Apache-2.0 SMALL/BASE/LARGE-1.1) runs multi-view and *conditioned on the SfM poses*, so depth comes out in SfM units and consistent across views. It then gets a robust per-view scale+shift refinement against sparse SfM depths (RANSAC + IRLS). Depth discontinuities and low-confidence pixels are removed, and a multi-view consistency check with free-space violation voting follows. A real-world scale (metres) is estimated with DA3-Metric-Large on 3 views. On a CUDA build of pycolmap, COLMAP PatchMatch MVS replaces this stage (`engines/colmap_mvs.py`). |
| fusion / meshing | Open3D `ScalableTSDFVolume`. The voxel size is the scene extent divided by 192/320/448, and marching cubes produces the mesh. |
| cleanup | Silhouette carving against the masks, removal of everything below the support plane (object mode), and removal of floaters (connected components). Boundary loops are capped with a well-tessellated harmonic membrane, so the unseen bottom and top become flat caps. Then Taubin smoothing, quadric decimation to `target_faces`, and manifold cleanup. |
| texturing | xatlas UV atlas, then texels are rasterized in UV space (Open3D ray casting) to get a 3D position and normal per texel. Each texel is projected into every view, with a visibility test against the mesh depth rendered from that view. Weights favour frontal, high-resolution observations away from image and silhouette edges, and the top-k views are blended with sharpened weights. Per-view exposure gains are compensated. Unseen texels get a smooth harmonic fill that fades to the region's median colour, and the atlas is padded by push-pull. |
| export | The model is made gravity-up (+Y, from camera up vectors / ground plane), the front faces +Z (toward the first photo), it is scaled to metres when the metric estimate is plausible, and the bottom centre sits at the origin. Outputs are `model.glb` (PBR baseColor texture), `model_obj.zip` (obj+mtl+png), `pointcloud.ply` (coloured dense points), `model.usdz` (UsdPreviewSurface, when `usd-core` is installed), `preview.glb` (about 10k faces, 1024 px texture re-baked from the full model), `thumbnail.png` (512 px RGBA, software ray-cast render) and `report.json` (metrics, per-stage timings, transform, notes). |

### Quality presets

| | draft | standard | high |
|---|---|---|---|
| max image side | 1280 | 2048 | 3072 |
| video frames | 40 | 80 | 120 |
| masks (BiRefNet input) | 512 | 768 | 1024 |
| keypoints / feature image side | 2048 / 1024 | 4096 / 1600 | 8192 / 2048 |
| exhaustive matching up to | 30 imgs | 40 | 60 |
| depth model / resolution | DA3-SMALL / 504 | DA3-BASE / 756 | DA3-LARGE-1.1 / 1008 |
| TSDF voxels across the object | 192 | 320 | 448 |
| default texture / faces | 1024 / 50k | 2048 / 100k | 4096 / 300k |

`texture_size` and `target_faces` in `config.json` override the preset. When they are absent, the
preset value is used. For `standard` these equal the contract defaults (2048 / 100000).

Measured on 4 CPU cores with no GPU, using the bundled 18-19 photos at 640x480 (October 2026):

| | box draft | box standard | box high | switch draft | switch standard |
|---|---|---|---|---|---|
| wall time | 2.2 min | 4.2 min | 9.4 min | 2.2 min | 4.3 min |
| registered | 19/19 | 19/19 | 19/19 | 18/18 | 18/18 |
| peak RAM | 2.7 GB | 4.9 GB | 7.2 GB | 2.7 GB | 5.0 GB |

A 40-frame draft from video takes about 4-5 min. On CPU, the time goes to masking (2.5 s per
image at 512 px, 5.5 s at 768 px, 10 s at 1024 px), learned matching (about 0.2-0.5 s per pair)
and DA3 (20 s / 70 s / 150 s per preset for about 19 views). Large meshes are UV-unwrapped in
parallel spatial chunks, so 300k faces take about 30 s.

For air-gapped containers, run `--download-models` at build time and set `HF_HUB_OFFLINE=1` at
runtime.

## GPU options

* **PatchMatch MVS**: build COLMAP/pycolmap with CUDA. `device=auto|cuda` then uses PatchMatch
  stereo for dense depth automatically. *Untested here.*
* **Faster everything**: with a CUDA torch, BiRefNet, LightGlue and DA3 run on the GPU (pass
  `device`). DA3-GIANT and the nested metric models are better still but are CC-BY-NC.
* **Feed-forward reconstruction** (VGGT / MASt3R / DA3 any-view without SfM poses): DA3 already
  provides most of this benefit while staying anchored to COLMAP poses. Running DA3 without poses
  is a reasonable future fallback for sets where SfM fails. VGGT-1B is not commercially licensed
  (VGGT-1B-Commercial exists under a separate licence).
* **Generative engine** (`engine: "generative"`, `engines/generative.py`, GPU only, **untested
  here**) turns a single photo into a textured mesh. It uses TRELLIS.2-4B (MIT; preferred) or
  Hunyuan3D-2 (Tencent licence, which excludes the EU, UK and South Korea). The best photo
  (largest uncut subject, sharpest) is chosen and segmented to RGBA, the model generates the
  mesh, and the result is normalised (bottom at y = 0, unit size) and passed through the same
  export stage. `--capabilities` reports it unavailable, with the reason, when there is no CUDA or
  no package. See `requirements-gpu.txt`.

## Known limitations

* **Unseen surfaces are invented.** The underside, and the top when every photo is taken at
  object height, are closed with a flat cap and an extrapolated colour. `report.json` gives the
  unseen fraction in `texture.seen_fraction`.
* **Low-resolution input limits detail.** With 640x480 samples the texture is soft. Geometry
  edges are rounded at about 1-2% of the object size, because TSDF fusion of learned depth smooths
  sharp corners.
* **Shiny, transparent and textureless objects** (metal tins, glass, white plastic) break both
  matching and depth. Expect holes, wavy walls or failed alignment.
* **Symmetric objects in unordered photo sets** can still fold (doppelgangers). Ordered captures
  (sequential file names, EXIF times, video) are protected by the offset-window pair selection.
* **Scale** is an estimate from monocular metric depth, typically within ±20%. `scale_source` in
  the metrics says whether it is `metric_estimate` or `normalized` (unit-diagonal fallback).
* **Scene mode** keeps the background and skips masking and carving. It suits small scenes and
  room corners. Large outdoor scenes need more photos than the presets assume.
* Open3D 0.20.0 returns empty meshes from TSDF marching cubes, so the pipeline pins 0.19.0.

## Capture tips (shown to users)

1. Move **around** the object: 30-60 photos in one or two rings, with each photo overlapping the
   previous one by more than 60%. Add a higher ring looking down to capture the top.
2. Keep the whole object in frame and fill about half the frame. Don't zoom between shots.
3. Use soft, even light with no harsh shadows or flash. Avoid reflections on glossy surfaces.
4. Use a textured background or surface (a newspaper or patterned cloth), not a blank white table.
5. Keep shots sharp: hold steady or use a timer. For video, walk slowly (about 20-30 s per orbit).
6. Don't move the object between shots. To capture the underside, run a separate scan.
7. Name or keep photos in capture order (phones do this by default). It improves robustness.

## Layout

```
cli.py           CLI entry, protocol, error mapping
config.py        config.json parsing + presets
progress.py      JSON-lines emitter, monotonic stage progress
runtime.py       stdout guard, signal watcher/cancellation, devices, model cache
models.py        weight registry, lazy downloads, --download-models
ingest.py        photos/HEIC/video -> frames, blur/duplicate filtering
masking.py       BiRefNet / rembg subject masks
sfm.py           ALIKED+LightGlue -> COLMAP DB -> incremental mapping, pair selection
depth.py         DA3 pose-conditioned depth, alignment, consistency filtering, metric scale
fusion.py        TSDF fusion, dense point cloud
cleanup.py       carving, ground removal, floaters, hole capping, decimation, normalisation
texturing.py     xatlas unwrap, multi-view texture baking
finalize.py      shared export stage (preview, thumbnail, report)
export.py        GLB / OBJ zip / PLY / USDZ writers
render.py        headless ray-cast renderer (thumbnails)
geometry.py      pure maths (robust fits, planes, rotations, sampling)
engines/         photogrammetry, colmap_mvs (CUDA), generative (CUDA)
tests/           unit tests + end-to-end (slow) tests
```
