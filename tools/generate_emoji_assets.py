"""Build the bundled emoji catalog and offline atlases from upstream art packages.

Usage: python tools/generate_emoji_assets.py <emoji-datasource package> <openmoji package> <emojione 2.2.7 package>
The inputs are unpacked npm packages. See public/emojis/ATTRIBUTION.md.
"""

import io
import json
import sys
from pathlib import Path

import cairosvg
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public" / "emojis"
CATALOG = ROOT / "src" / "core" / "emoji_catalog.json"
LIMITS = {
    "Smileys & Emotion": 105,
    "People & Body": 75,
    "Animals & Nature": 55,
    "Food & Drink": 50,
    "Travel & Places": 45,
    "Activities": 45,
    "Objects": 65,
    "Symbols": 60,
    "Flags": 30,
}
PRIORITY = {
    "1F602", "1F923", "1F970", "1F60D", "1F62D", "1F44D", "1F44E",
    "1F64F", "1F44F", "1F525", "1F4AF", "2764-FE0F", "1F496", "1F49C",
    "1F389", "1F680", "1F4A9", "1F914", "1F440", "1F91D", "1F91E",
    "1F48B", "1F3AE", "1F3B5", "1F355", "1F37A", "1F436", "1F431",
    "1F1E7-1F1F7", "1F1F5-1F1F9", "1F1FA-1F1F8", "1F1EF-1F1F5",
}


def unicode_text(codepoints):
    return "".join(chr(int(part, 16)) for part in codepoints.split("-"))


def main(data_dir, openmoji_dir, emojione_dir):
    entries = json.loads((data_dir / "emoji.json").read_text(encoding="utf-8"))
    entries.sort(key=lambda item: item["sort_order"])
    counts = {name: 0 for name in LIMITS}
    selected = []
    for item in entries:
        category = item.get("category")
        if category not in LIMITS or not item.get("has_img_google") or not item.get("has_img_twitter"):
            continue
        if counts[category] >= LIMITS[category] and item["unified"] not in PRIORITY:
            continue
        counts[category] += 1
        selected.append(item)

    OUTPUT.mkdir(parents=True, exist_ok=True)
    source_sheets = {
        pack: Image.open(data_dir / "img" / folder / "sheets" / "32.png").convert("RGBA")
        for pack, folder in (("twemoji", "twitter"), ("noto", "google"))
    }
    width = 16 * 32
    height = ((len(selected) + 15) // 16) * 32
    atlases = {pack: Image.new("RGBA", (width, height)) for pack in ("twemoji", "noto", "openmoji", "classic")}
    catalog = []
    missing_openmoji = 0
    for index, item in enumerate(selected):
        x, y = index % 16 * 32, index // 16 * 32
        for pack, sheet in source_sheets.items():
            # emoji-datasource sheets use 32px images with a 1px transparent gutter.
            sx, sy = item["sheet_x"] * 34 + 1, item["sheet_y"] * 34 + 1
            atlases[pack].paste(sheet.crop((sx, sy, sx + 32, sy + 32)), (x, y))

        code = item["unified"]
        openmoji_path = openmoji_dir / "color" / "svg" / f"{code}.svg"
        if not openmoji_path.exists():
            openmoji_path = openmoji_dir / "color" / "svg" / f"{code.replace('-FE0F', '')}.svg"
        if openmoji_path.exists():
            image = Image.open(io.BytesIO(cairosvg.svg2png(url=str(openmoji_path), output_width=32, output_height=32)))
            atlases["openmoji"].paste(image, (x, y))
        else:
            missing_openmoji += 1
            atlases["openmoji"].paste(atlases["twemoji"].crop((x, y, x + 32, y + 32)), (x, y))

        classic_dir = emojione_dir / "assets" / "png"
        classic_path = classic_dir / f"{code.lower()}.png"
        if not classic_path.exists():
            classic_path = classic_dir / f"{code.replace('-FE0F', '').lower()}.png"
        has_classic = classic_path.exists()
        if has_classic:
            classic_image = Image.open(classic_path).convert("RGBA").resize((32, 32), Image.Resampling.LANCZOS)
            atlases["classic"].paste(classic_image, (x, y))

        catalog.append({
            "emoji": unicode_text(code),
            "alternate": unicode_text(item["non_qualified"]) if item.get("non_qualified") else None,
            "name": item["short_name"].replace("_", " "),
            "category": item["category"],
            "classic": has_classic,
        })

    for pack, image in atlases.items():
        image.save(OUTPUT / f"{pack}.png", optimize=True)
    CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Built {len(catalog)} emojis; {sum(item['classic'] for item in catalog)} classic icons; {missing_openmoji} OpenMoji cells use Twemoji fallback")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
