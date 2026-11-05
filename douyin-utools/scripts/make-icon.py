"""Optional artwork source; Pillow is only needed to regenerate logo.png."""
from pathlib import Path
from PIL import Image, ImageDraw
S = 4
im = Image.new('RGBA', (256*S, 256*S), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
def pts(values): return [(round(x*S), round(y*S)) for x,y in values]
d.rounded_rectangle((8*S, 8*S, 248*S, 248*S), radius=58*S, fill='#245b4c')
for line in [[(88,55),(60,55),(60,112)],[(171,55),(199,55),(199,112)],[(60,169),(60,205),(115,205)],[(199,169),(199,205),(145,205)]]:
    d.line(pts(line), fill='#f3f4e9', width=10*S, joint='curve')
d.polygon(pts([(111,94),(170,129),(111,164)]), fill='#c4d8a9')
im.resize((256,256), Image.Resampling.LANCZOS).save(Path(__file__).resolve().parents[1] / 'logo.png')
