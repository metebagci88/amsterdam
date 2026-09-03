# CDP-3B · Vendor (self-hosted) GrapesJS dosyaları

Production'da **CDN'den runtime bağımlılık YOK**. Aşağıdaki dosyalar sürüm-sabit olarak npm'den alınıp repoda barındırılır; admin.html bunları **kendi origin'imizden** yükler. SRI (Subresource Integrity) için `sha384` base64 değeri de üretilmeli (aşağıda sha256 hex verildi; deploy adımında `<script integrity>` için sha384 hesaplanacak).

| Dosya | Kaynak (npm/unpkg) | Sürüm | Lisans | Boyut (byte) | SHA-256 |
|---|---|---|---|---|---|
| `grapesjs/grapes.min.js` | `grapesjs@0.21.11` → `dist/grapes.min.js` | 0.21.11 | BSD-3-Clause | 989571 | `ef1148f91d22dee3a3f912e14582c1d8deaee076633a4a50c7479245c8541129` |
| `grapesjs/grapes.min.css` | `grapesjs@0.21.11` → `dist/css/grapes.min.css` | 0.21.11 | BSD-3-Clause | 60996 | `92d7f8742ee053f525dcec4bea0f12386213fcc8c739ab3b57a040b77f253387` |
| `grapesjs/grapesjs-preset-newsletter.index.js` | `grapesjs-preset-newsletter@1.0.2` → `dist/index.js` (min.js YOK) | 1.0.2 | BSD-3-Clause | 396044 | `3d950fc726f3212434e33d89b3a4c3fbe5aa76a66aee5b9d87a20846a5b27f78` |

## Notlar
- Global adı: `grapesjs` (core) + `grapesjs-preset-newsletter` (preset UMD). Init: `plugins:['grapesjs-preset-newsletter']`.
- Preset'in `dist/index.js` UMD'si canlı tarayıcıda doğrulandı (init OK, **14 blok**, değişken korunur).
- Deploy: `grapes.min.js` + `grapes.min.css` + `grapesjs-preset-newsletter.index.js` repo `vendor/` altında; admin.html referansları relatif (ör. `/vendor/grapesjs/...`).
- **CSP:** `script-src 'self'` (CDN yok); `style-src 'self' 'unsafe-inline'` (GrapesJS inline stil kullanır); editör iframe'i `sandbox`.
- **SRI:** production `<script src="/vendor/grapesjs/grapes.min.js" integrity="sha384-..." crossorigin="anonymous">`. sha384 değerleri deploy paketinde üretilecek (dosyalar yukarıdaki sha256 ile bütünlük-kilitli).
- Lisans metinleri (BSD-3-Clause) `vendor/grapesjs/LICENSE` olarak eklenmeli (deploy paketinde).
