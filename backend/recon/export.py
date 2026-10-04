"""Artifact writers: GLB, OBJ (zip), PLY point cloud, USDZ, preview GLB, thumbnail, report."""

from __future__ import annotations

import io
import json
import logging
import zipfile
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .cleanup import Mesh

log = logging.getLogger("recon")


def _trimesh(mesh: Mesh, name: str = "model"):  # type: ignore[no-untyped-def]
    import trimesh
    from trimesh.visual.material import PBRMaterial
    from trimesh.visual.texture import TextureVisuals

    if mesh.UV is not None and mesh.texture is not None:
        mat = PBRMaterial(
            name=f"{name}_material",
            baseColorTexture=Image.fromarray(mesh.texture),
            baseColorFactor=[255, 255, 255, 255],
            metallicFactor=0.0,
            roughnessFactor=0.85,
            doubleSided=False,
        )
        visual = TextureVisuals(uv=mesh.UV, material=mat)
        return trimesh.Trimesh(vertices=mesh.V, faces=mesh.F, visual=visual, process=False)
    tm = trimesh.Trimesh(vertices=mesh.V, faces=mesh.F, process=False)
    if mesh.C is not None:
        tm.visual.vertex_colors = np.clip(np.c_[mesh.C, np.ones(len(mesh.C))] * 255, 0, 255).astype(np.uint8)
    return tm


def write_glb(mesh: Mesh, path: Path) -> None:
    tm = _trimesh(mesh)
    data = tm.export(file_type="glb")
    path.write_bytes(data)


def write_obj_zip(mesh: Mesh, path: Path, stem: str = "model") -> None:
    from trimesh.exchange.obj import export_obj

    tm = _trimesh(mesh, stem)
    result = export_obj(tm, include_normals=True, include_color=True, include_texture=True, return_texture=True, mtl_name=f"{stem}.mtl")
    if isinstance(result, tuple):
        obj_text, files = result
    else:  # pragma: no cover - untextured
        obj_text, files = result, {}
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{stem}.obj", obj_text)
        for name, data in files.items():
            z.writestr(name, data)


def write_ply_points(points: np.ndarray, colors: np.ndarray | None, path: Path, normals: np.ndarray | None = None) -> None:
    """Binary little-endian PLY with float xyz (+normals) and uchar rgb."""
    n = len(points)
    fields = [("x", "<f4"), ("y", "<f4"), ("z", "<f4")]
    if normals is not None:
        fields += [("nx", "<f4"), ("ny", "<f4"), ("nz", "<f4")]
    if colors is not None:
        fields += [("red", "u1"), ("green", "u1"), ("blue", "u1")]
    arr = np.zeros(n, dtype=fields)
    arr["x"], arr["y"], arr["z"] = points[:, 0], points[:, 1], points[:, 2]
    if normals is not None:
        arr["nx"], arr["ny"], arr["nz"] = normals[:, 0], normals[:, 1], normals[:, 2]
    if colors is not None:
        c = colors if colors.dtype == np.uint8 else np.clip(colors * 255 + 0.5, 0, 255).astype(np.uint8)
        arr["red"], arr["green"], arr["blue"] = c[:, 0], c[:, 1], c[:, 2]
    tmap = {"<f4": "float", "u1": "uchar"}
    header = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {n}\n"
    header += "".join(f"property {tmap[t]} {name}\n" for name, t in fields) + "end_header\n"
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(arr.tobytes())


def write_usdz(mesh: Mesh, path: Path) -> bool:
    """USDZ (AR Quick Look) with a UsdPreviewSurface material. Returns False if usd-core is missing."""
    try:
        from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, UsdUtils, Vt
    except Exception:
        log.info("usd-core not installed; skipping USDZ")
        return False
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        usdc = tdp / "model.usdc"
        tex_name = "texture.png"
        stage = Usd.Stage.CreateNew(str(usdc))
        UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
        UsdGeom.SetStageMetersPerUnit(stage, 1.0)
        root = UsdGeom.Xform.Define(stage, "/Model")
        stage.SetDefaultPrim(root.GetPrim())
        geom = UsdGeom.Mesh.Define(stage, "/Model/Geom")
        geom.CreatePointsAttr(Vt.Vec3fArray.FromNumpy(mesh.V.astype(np.float32)))
        geom.CreateFaceVertexCountsAttr(Vt.IntArray.FromNumpy(np.full(len(mesh.F), 3, np.int32)))
        geom.CreateFaceVertexIndicesAttr(Vt.IntArray.FromNumpy(mesh.F.astype(np.int32).ravel()))
        geom.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
        geom.CreateDoubleSidedAttr(False)
        from .texturing import vertex_normals

        nrm = vertex_normals(mesh.V, mesh.F).astype(np.float32)
        geom.CreateNormalsAttr(Vt.Vec3fArray.FromNumpy(nrm))
        geom.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
        lo, hi = mesh.V.min(0), mesh.V.max(0)
        geom.CreateExtentAttr([Gf.Vec3f(*map(float, lo)), Gf.Vec3f(*map(float, hi))])

        mat = UsdShade.Material.Define(stage, "/Model/Material")
        shader = UsdShade.Shader.Define(stage, "/Model/Material/PreviewSurface")
        shader.CreateIdAttr("UsdPreviewSurface")
        shader.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(0.0)
        shader.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(0.85)
        mat.CreateSurfaceOutput().ConnectToSource(shader.ConnectableAPI(), "surface")
        if mesh.UV is not None and mesh.texture is not None:
            Image.fromarray(mesh.texture).save(tdp / tex_name)
            pv = UsdGeom.PrimvarsAPI(geom).CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex)
            pv.Set(Vt.Vec2fArray.FromNumpy(mesh.UV.astype(np.float32)))
            reader = UsdShade.Shader.Define(stage, "/Model/Material/STReader")
            reader.CreateIdAttr("UsdPrimvarReader_float2")
            st_in = mat.CreateInput("frame:stPrimvarName", Sdf.ValueTypeNames.Token)
            st_in.Set("st")
            reader.CreateInput("varname", Sdf.ValueTypeNames.Token).ConnectToSource(st_in)
            tex = UsdShade.Shader.Define(stage, "/Model/Material/Diffuse")
            tex.CreateIdAttr("UsdUVTexture")
            tex.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(tex_name)
            tex.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(reader.ConnectableAPI(), "result")
            tex.CreateInput("wrapS", Sdf.ValueTypeNames.Token).Set("clamp")
            tex.CreateInput("wrapT", Sdf.ValueTypeNames.Token).Set("clamp")
            tex.CreateInput("sourceColorSpace", Sdf.ValueTypeNames.Token).Set("sRGB")
            tex.CreateOutput("rgb", Sdf.ValueTypeNames.Float3)
            shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(tex.ConnectableAPI(), "rgb")
        else:
            shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(0.7, 0.7, 0.7))
        UsdShade.MaterialBindingAPI.Apply(geom.GetPrim()).Bind(mat)
        stage.GetRootLayer().Save()
        ok = UsdUtils.CreateNewARKitUsdzPackage(Sdf.AssetPath(str(usdc)), str(path))
        return bool(ok) and path.exists()


def write_png(img: np.ndarray, path: Path) -> None:
    Image.fromarray(img).save(path, optimize=True)


def write_json(obj: Any, path: Path) -> None:
    from .progress import _json_default

    path.write_text(json.dumps(obj, indent=2, default=_json_default), encoding="utf-8")


def glb_bytes_ok(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"glTF"
    except OSError:
        return False


def encode_png(img: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="PNG")
    return buf.getvalue()
