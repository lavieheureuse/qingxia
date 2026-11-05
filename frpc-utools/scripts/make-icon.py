#!/usr/bin/env python3
"""生成 frpc uTools 插件图标（256x256 PNG）。

设计：森林绿圆角底 + 白色隧道拱形（两层，暗示纵深）+ 中心连接点。
只用 Pillow，无外部素材；先按 1024px 绘制再用 LANCZOS 缩到 256，边缘更干净。

用法（仓库内可复现）：
    python scripts/make-icon.py

输出：<plugin>/logo.png（本脚本所在目录的上一级）。
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 256          # 最终尺寸
SUPERSAMPLE = 4     # 超采样倍数
S = SIZE * SUPERSAMPLE

# 取色自 styles.css：--accent #315c43，向更暗的森林绿渐变。
GRADIENT_TOP = (61, 110, 82)
GRADIENT_BOTTOM = (33, 63, 45)
INK = (246, 249, 242)   # --on-accent
OUTLINE = (255, 255, 255, 36)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def gradient(size: int) -> Image.Image:
    layer = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(layer)
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(round(GRADIENT_TOP[i] + (GRADIENT_BOTTOM[i] - GRADIENT_TOP[i]) * t) for i in range(3))
        draw.line([(0, y), (size, y)], fill=color + (255,))
    return layer


def stroke(draw: ImageDraw.ImageDraw, points, width: int, color) -> None:
    """折线 + 圆头端点。"""
    draw.line(points, fill=color, width=width, joint="curve")
    radius = width // 2
    for x, y in (points[0], points[-1]):
        draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color)


def draw_arch(draw: ImageDraw.ImageDraw, cx: int, center_y: int, radius: int, leg_y: int, width: int, color) -> None:
    bbox = [cx - radius, center_y - radius, cx + radius, center_y + radius]
    draw.arc(bbox, start=180, end=360, fill=color, width=width)
    for x in (cx - radius, cx + radius):
        stroke(draw, [(x, center_y), (x, leg_y)], width, color)


def main() -> None:
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    canvas.paste(gradient(S), (0, 0), rounded_mask(S, round(S * 0.22)))

    draw = ImageDraw.Draw(canvas)

    cx = S // 2
    # 外层隧道：更宽，落地更低。
    draw_arch(draw, cx, round(S * 0.50), round(S * 0.235), round(S * 0.80), round(S * 0.062), INK + (255,))
    # 内层隧道：稍细，制造纵深；与外层留出均匀间隙。
    draw_arch(draw, cx, round(S * 0.50), round(S * 0.145), round(S * 0.72), round(S * 0.046), INK + (235,))

    # 中心连接点：隧道尽头的信号灯。
    dot_y = round(S * 0.665)
    dot_r = round(S * 0.040)
    draw.ellipse([cx - dot_r, dot_y - dot_r, cx + dot_r, dot_y + dot_r], fill=INK + (255,))

    icon = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    out = Path(__file__).resolve().parent.parent / "logo.png"
    icon.save(out, "PNG", optimize=True)
    print(f"wrote {out} ({icon.width}x{icon.height})")


if __name__ == "__main__":
    main()
