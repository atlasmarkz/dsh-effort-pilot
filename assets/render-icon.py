"""Render the raster storefront icon (180x180 and 512x512) for dsh-effort-pilot.

Pillow is used directly instead of converting the SVG so the build has no extra
image tooling dependency. The drawing mirrors assets/logo.svg.
"""
from PIL import Image, ImageDraw, ImageFilter

SCALE = 8  # draw large, downsample for clean anti-aliased edges


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    image = Image.new('RGB', (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        draw.line(((0, y), (size, y)), fill=color)
    return image


def bar_gradient(width: int, height: int, bottom: tuple[int, int, int], top: tuple[int, int, int]) -> Image.Image:
    image = Image.new('RGB', (width, height))
    draw = ImageDraw.Draw(image)
    for y in range(height):
        t = 1 - y / max(1, height - 1)
        color = tuple(round(bottom[i] + (top[i] - bottom[i]) * t) for i in range(3))
        draw.line(((0, y), (width, y)), fill=color)
    return image


def render(size: int) -> Image.Image:
    s = size * SCALE
    unit = s / 256.0

    def box(*values: float) -> tuple[float, float, float, float]:
        return tuple(round(v * unit) for v in values)

    canvas = Image.new('RGBA', (s, s), (0, 0, 0, 0))

    # rounded background
    background = vertical_gradient(s, (18, 29, 51), (7, 11, 20))
    radius = round(58 * unit)
    canvas.paste(background, (0, 0), rounded_mask(s, radius))

    draw = ImageDraw.Draw(canvas)
    # faint inner border
    draw.rounded_rectangle(
        (round(8.75 * unit), round(8.75 * unit), s - round(8.75 * unit), s - round(8.75 * unit)),
        radius=round(57.25 * unit),
        outline=(34, 53, 92, 255),
        width=max(1, round(1.5 * unit)),
    )

    bars = [
        (50, 152, 30, 56, (47, 91, 208), (91, 140, 255)),
        (92, 122, 30, 86, (63, 110, 230), (127, 166, 255)),
        (133, 86, 30, 122, (109, 91, 255), (183, 155, 255)),
    ]
    for x, y, width, height, bottom, top in bars:
        left, upper, right, lower = box(x, y, x + width, y + height)
        bar = bar_gradient(right - left, lower - upper, bottom, top)
        bar_mask = Image.new('L', (right - left, lower - upper), 0)
        ImageDraw.Draw(bar_mask).rounded_rectangle(
            (0, 0, right - left - 1, lower - upper - 1), radius=round(10 * unit), fill=255
        )
        canvas.paste(bar, (left, upper), bar_mask)

    # autopilot dial
    dial_layer = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    dial = ImageDraw.Draw(dial_layer)
    dial.arc(
        (round(129 * unit), round(50 * unit), round(221 * unit), round(142 * unit)),
        start=-90,
        end=0,
        fill=(79, 140, 255, 140),
        width=round(8 * unit),
    )
    dial.line(
        (round(196 * unit), round(160 * unit), round(212 * unit), round(124 * unit)),
        fill=(234, 242, 255, 255),
        width=round(8 * unit),
    )
    dial.ellipse(
        box(188.5, 152.5, 203.5, 167.5),
        fill=(234, 242, 255, 255),
    )
    dial_layer = dial_layer.filter(ImageFilter.GaussianBlur(round(3.2 * unit)))
    dial_layer = Image.composite(dial_layer, Image.new('RGBA', (s, s), (0, 0, 0, 0)), dial_layer.split()[3])
    canvas.alpha_composite(dial_layer)

    # sharp pass on top of the soft glow
    top = ImageDraw.Draw(canvas)
    top.arc(
        (round(129 * unit), round(50 * unit), round(221 * unit), round(142 * unit)),
        start=-90,
        end=0,
        fill=(79, 140, 255, 225),
        width=max(2, round(4.5 * unit)),
    )
    top.line(
        (round(196 * unit), round(160 * unit), round(212 * unit), round(124 * unit)),
        fill=(255, 255, 255, 255),
        width=max(2, round(5.5 * unit)),
    )
    top.ellipse(box(189, 153, 203, 167), fill=(234, 242, 255, 255))

    return canvas.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    from pathlib import Path

    out = Path(__file__).resolve().parent
    render(180).save(out / 'icon-180.png', optimize=True)
    render(512).save(out / 'logo-512.png', optimize=True)
    render(96).save(out / 'icon-96.png', optimize=True)
    print('wrote icon-180.png, icon-96.png, logo-512.png')
