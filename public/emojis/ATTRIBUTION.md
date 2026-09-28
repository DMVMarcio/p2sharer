# Emoji artwork and data

The emoji catalog and offline atlases were generated with `tools/generate_emoji_assets.py`.

- Emoji metadata and sprite layout: [emoji-datasource](https://github.com/iamcal/emoji-data), MIT License, © Cal Henderson.
- Twemoji artwork: [Twemoji](https://github.com/jdecked/twemoji), CC BY 4.0, © Twitter and contributors.
- Noto Emoji artwork: [Noto Emoji](https://github.com/googlefonts/noto-emoji), Apache License 2.0, © Google and contributors.
- OpenMoji artwork: [OpenMoji](https://openmoji.org/), CC BY-SA 4.0, © OpenMoji contributors.
- EmojiOne 2.2.7 classic artwork: [EmojiOne v2.2.7](https://github.com/Ranks/emojione/tree/v2.2.7), CC BY 4.0, © Ranks.com. The atlas resizes the original PNG images; unsupported newer emojis fall back to the system font.

The native style uses the operating system emoji font and bundles no additional artwork.

To regenerate the atlases, unpack `emoji-datasource@16.0.0`, `openmoji@17.0.0`, and `emojione@2.2.7` from npm, install Python's Pillow and CairoSVG packages, then run `python tools/generate_emoji_assets.py <emoji-datasource package> <openmoji package> <emojione package>`.
