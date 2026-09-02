from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]

SOURCES = {
    "server": Path(r"C:\Users\anvar\AppData\Local\Temp\codex-clipboard-d9667d95-91c7-44e4-bcf7-6e44512abe7e.png"),
    "student": Path(r"C:\Users\anvar\AppData\Local\Temp\codex-clipboard-101432df-8c3d-434b-a381-df65ad83413b.png"),
}

COLORS = {
    "server": (239, 25, 35, 255),
    "student": (0, 211, 89, 255),
}


def contain(image: Image.Image, size: tuple[int, int], padding: int = 0) -> Image.Image:
    output = Image.new("RGBA", size, (0, 0, 0, 0))
    available = (size[0] - padding * 2, size[1] - padding * 2)
    fitted = image.copy()
    fitted.thumbnail(available, Image.Resampling.LANCZOS)
    output.alpha_composite(fitted, ((size[0] - fitted.width) // 2, (size[1] - fitted.height) // 2))
    return output


def remove_connected_black_background(image: Image.Image) -> Image.Image:
    cleaned = image.copy()
    for point in ((0, 0), (cleaned.width - 1, 0), (0, cleaned.height - 1), (cleaned.width - 1, cleaned.height - 1)):
        ImageDraw.floodfill(cleaned, point, (0, 0, 0, 0), thresh=22)
    return cleaned


def build(kind: str) -> None:
    source = remove_connected_black_background(Image.open(SOURCES[kind]).convert("RGBA"))
    app_dir = ROOT / "apps" / kind
    build_dir = app_dir / "build"
    public_dir = app_dir / "src" / "renderer" / "public" / "branding"
    build_dir.mkdir(parents=True, exist_ok=True)
    public_dir.mkdir(parents=True, exist_ok=True)

    source.save(public_dir / "logo.png", optimize=True)

    icon = Image.new("RGBA", (512, 512), (10, 12, 17, 255))
    draw = ImageDraw.Draw(icon)
    draw.rounded_rectangle((42, 42, 470, 470), radius=112, fill=COLORS[kind])
    draw.rounded_rectangle((100, 178, 412, 334), radius=74, fill=(0, 0, 0, 255))
    word = "SERVER" if kind == "server" else "STUDENT"
    # The wide supplied logo remains the authoritative wordmark; this compact mark stays legible at icon sizes.
    compact = contain(source, (420, 180), padding=8)
    icon.alpha_composite(compact, (46, 166))
    icon.save(build_dir / "icon.png", optimize=True)
    icon.save(build_dir / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    sidebar = contain(source, (164, 314), padding=12)
    background = Image.new("RGB", sidebar.size, (9, 11, 16))
    background.paste(sidebar, mask=sidebar.getchannel("A"))
    background.save(build_dir / "installer-sidebar.bmp")

    header = contain(source, (150, 57), padding=5)
    header_background = Image.new("RGB", header.size, (255, 255, 255))
    header_background.paste(header, mask=header.getchannel("A"))
    header_background.save(build_dir / "installer-header.bmp")


for app_kind in SOURCES:
    build(app_kind)
