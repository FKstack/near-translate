# 图标生成提示词

使用内置 `image_gen`，两次均请求透明背景。最终交付的平面 SVG 由概念方向重新绘制；PNG 从 SVG 导出。

## 初次生成

```text
Use case: logo-brand.
Asset type: production browser extension icon for the Chinese bilingual webpage / selection / PDF translator named Near Translate (近译). Create one original standalone symbol, no lettering.
Primary request: A fresh, calm, natural "two leaves in conversation" mark. Fuse two simple opposing speech bubbles with the organic silhouette of two leaves. The upper-left bubble is deep jade teal, the lower-right bubble is fresh mint green. Each is a generous solid rounded leaf-like shape with just one clear speech-tail. The two forms gently overlap with a clean broad transparent negative-space separation, suggesting source language and translation, closeness, and an opening book. Keep the dialogue-bubble meaning obvious. The mark must have a unique balanced silhouette and feel like a finished software brand.
Style: exceptionally clean flat vector-like logo; exactly two solid color fills; crisp smooth edges.
Palette: deep jade teal approximately #087F83 and fresh mint approximately #66CC9E, harmonious with the extension's existing cyan-teal UI.
Composition: square canvas, centered compact symbol occupying about 82% of width and 76% of height; balanced optical weight and comfortable transparent padding. Fully transparent background outside the mark and in the separation.
Constraints: must remain legible at 16 and 32 pixels. Only two bold shapes. No leaf veins, no fine strokes, no tiny details, no letters, no characters, no dots, no arrows, no surrounding rounded square tile. No gradients, shadows, texture, blur, glass, 3D, glossy effects, decorative sprouts, mockup, border, scene, watermark, grid or presentation sheet. Generate a single icon, not variants.
```

## 定向迭代

```text
Use case: logo-brand. Edit the supplied original icon. Make exactly one change: replace the textured/gradient fills by perfectly uniform flat solid fills, deep jade teal #087F83 for the upper-left leaf speech bubble, fresh mint green #66CC9E for the lower-right leaf speech bubble. Absolutely no gradient, shading, texture, light, highlights, shadows, glow, bevel or noise anywhere. Crisp smooth antialiased contours. Preserve the exact two organic leaf/speech bubble shapes, their positions, scale, spacing, proportions, transparent padding and broad transparent gap. Keep background and gap genuinely transparent. No additional shapes, no text, no surrounding tile. This is a small browser toolbar icon that needs a clean two-color silhouette.
```
