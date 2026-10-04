import io

from PIL import Image


def png_bytes(w=640, h=480, color=(200, 30, 30), fmt="PNG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, fmt)
    return buf.getvalue()


def jpeg_bytes(w=800, h=600) -> bytes:
    return png_bytes(w, h, (20, 120, 200), "JPEG")


def mp4_bytes(size=4096) -> bytes:
    return b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * size
