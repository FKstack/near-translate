# Near Document Sans

`NearDocumentSans.ttf.gz` is the repository's compact source for a local, static Regular TrueType derivative of Noto Sans SC 2.004. The build decompresses and verifies it, then writes the real `NearDocumentSans.ttf` to `public/fonts/`; only the ordinary TTF is included in the extension package. Native PDF generation loads the complete local TTF on demand, without downloading a font or decompressing an archive in the browser. Browser layout and pdf-lib receive identical TTF bytes.

- Compressed source size: **6,319,428 bytes** (gzip level 9).
- Decoded TTF file size: **10,642,808 bytes**.
- Decoded TTF SHA-256: `40d7aa23a3cb25765a3b019136fdfe70a9f08f428d8e1042f0d472fde376132a`.
- Original copyright: **© 2014–2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.**
- License: **SIL Open Font License 1.1**, preserved in [`NotoSansSC-OFL.txt`](../licenses/NotoSansSC-OFL.txt) and copied into the release's `licenses/` directory. Copyright and license metadata are also retained in the font.
- Original official asset: <https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf>.
- Original asset size: **17,773,132 bytes**.
- Original asset SHA-256: `d68bafcb48a2707749396aa12bbbd833cb70401f3a9a689fd2902c7e0d295964`.
- Original license: <https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/LICENSE>.

## Modifications

Generated with FontTools **4.60.1**, pinning the `wght` axis to **400** and removing variable font tables. The family, style, full name, unique identifier and PostScript name are renamed to **Near Document Sans / Regular** and **NearDocumentSans-Regular**. The upstream copyright and OFL license metadata remain intact. This name does not use the upstream Reserved Font Name.

The `glyf` table uses **four-byte glyph padding**. This is required for reliable subsetting with the bundled `@pdf-lib/fontkit` **1.1.1**: without even glyph alignment, its short `loca` offsets can point into truncated glyph data. Do not replace this file with an unaligned FontTools instance or the original CFF OTF.

Equivalent generation steps, after verifying the original asset hash:

```python
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

font = TTFont("NotoSansSC-VF.ttf")
instantiateVariableFont(font, {"wght": 400}, inplace=True)
names = {
    1: "Near Document Sans",
    2: "Regular",
    3: "Near Document Sans Regular 2.004",
    4: "Near Document Sans Regular",
    6: "NearDocumentSans-Regular",
    16: "Near Document Sans",
    17: "Regular",
}
for record in font["name"].names:
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding())
font["glyf"].padding = 4
font.save("NearDocumentSans.ttf")
```

The generated font's modification timestamp can differ between runs. The published binary is identified by its SHA-256 above.

The repository source uses lossless gzip compression, without removing or changing any glyph, table, metadata or alignment. Reproduce that source with Node.js `gzipSync(ttfBytes, { level: 9 })`. During `npm run assets:pdf`, bounded Node.js decompression must match the decoded size and SHA-256 above before the ordinary TTF is written. The build removes any obsolete generated `.ttf.gz` so an incremental build cannot accidentally ship a nested archive.

Store packages use the outer extension ZIP to compress the ordinary TTF. This increases installed asset bytes by 4,323,380 compared with shipping gzip, while preserving the font, PDF glyph coverage and the same on-demand font memory. It avoids the nested compressed resource rejected by the Microsoft Edge Add-ons package validator; a `.gz` resource must not be restored to the published package or merely renamed to `.ttf`.

## PDF embedding and validation

Register `@pdf-lib/fontkit`, then embed the local TTF with `pdfDocument.embedFont(bytes, { subset: true })`. Use the resulting font for vector text, and reuse that font object across all pages. The font contains **30,890 Unicode mappings / 31,036 glyphs**. It covers common Simplified/Traditional Chinese, Latin, Japanese kana and several mathematical symbols. It does not cover every Unicode character: for example Hangul, Arabic, Devanagari, emoji and the rare Han character `𠮷` are absent. Check the actual input against `font.getCharacterSet()` and report unsupported characters rather than silently emitting blank text.

The shipped asset was verified with `pdf-lib` **1.17.1**, `@pdf-lib/fontkit` **1.1.1** and PDF.js **6.4.299**. A three-page native PDF was **15,054 bytes** and preserved exact Unicode extraction for Chinese, Traditional Chinese, Japanese, English including `office fi ffi 2026`, Greek letters and mathematical symbols. Each distinct test character was also rendered separately and checked for visible pixels; no empty glyphs remained. The test PDF and rendered pages were visually inspected.

The smaller upstream `NotoSansSC-Regular.otf` (8,331,336 bytes) was evaluated but not shipped: CFF subsetting in this dependency combination dropped visible glyphs despite successful Unicode extraction. A successful text extraction alone is therefore insufficient to validate a replacement font.
