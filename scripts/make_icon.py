"""Generate the original Yuchi Labs desktop mark in the target workspace."""
from pathlib import Path
from math import cos, sin, pi

from PIL import Image, ImageDraw


def main() -> None:
    folder = Path(__file__).resolve().parents[1] / "src-tauri" / "icons"
    folder.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((6, 6, 250, 250), radius=48, fill="#28483c", outline="#63977f", width=4)
    draw.ellipse((48, 48, 208, 208), outline="#c4edda", width=10)
    center = (128, 128)
    for index in range(6):
        angle = index * pi / 3
        points = []
        for radius, offset in ((20, -.35), (76, -.50), (76, .33)):
            points.append((center[0] + radius * cos(angle + offset), center[1] + radius * sin(angle + offset)))
        draw.polygon(points, fill="#a4d9bc")
    draw.ellipse((111, 111, 145, 145), fill="#28483c", outline="#c4edda", width=4)
    image.save(folder / "icon.png")
    image.save(folder / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(folder / "icon.ico")


if __name__ == "__main__":
    main()
