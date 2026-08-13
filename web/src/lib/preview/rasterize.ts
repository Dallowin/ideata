/**
 * Клиентская растеризация HTML-сцены в PNG/JPEG: SVG <foreignObject> + встроенные
 * (data-URI) шрифты и картинки, чтобы canvas.toBlob не тайнился CORS. Общий код
 * для конструктора превью (объектный холст) и обложек.
 */

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[])
  }
  return btoa(bin)
}

/** Скачать Google-шрифты и вернуть @font-face CSS с woff2 в data-URI (без ссылок). */
export async function embedFontCss(href: string): Promise<string> {
  const res = await fetch(href)
  if (!res.ok) throw new Error('css2 ' + res.status)
  let css = await res.text()
  const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))]
  const pairs = await Promise.all(urls.map(async (u) => {
    try {
      const b = await (await fetch(u)).arrayBuffer()
      return [u, `data:font/woff2;base64,${bufToB64(b)}`] as const
    } catch { return [u, u] as const }
  }))
  for (const [u, d] of pairs) css = css.split(u).join(d)
  return css
}

/** Любой (same-origin) URL → data-URI. Для встраивания картинок в экспорт. */
export async function toDataUri(url: string): Promise<string> {
  const b = await (await fetch(url)).blob()
  return await new Promise<string>((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(fr.result as string)
    fr.onerror = rej
    fr.readAsDataURL(b)
  })
}

export interface RasterParts { css: string; inner: string; width: number; height: number }

/** Отрисовать CSS+HTML сцены в Blob. mime png/jpeg, scale — множитель ретины. */
export async function rasterize(parts: RasterParts, opts: { mime?: 'image/png' | 'image/jpeg'; quality?: number; scale?: number; jpegBg?: string } = {}): Promise<Blob> {
  const { mime = 'image/png', quality = 0.92, scale = 2, jpegBg = '#ffffff' } = opts
  // <style> в CDATA: «&»/«<» в CSS (url картинок/шрифтов) иначе рвут XML-разметку SVG.
  const styleCss = parts.css.replace(/]]>/g, ']]]]><![CDATA[>')
  const inner =
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${parts.width}px;height:${parts.height}px">` +
    `<style><![CDATA[${styleCss}]]></style><div class="stage">${parts.inner}</div></div>`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${parts.width}" height="${parts.height}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">${inner}</foreignObject></svg>`
  // ТОЛЬКО data-URI. НЕ переводить на Blob-URL: SVG, загруженный из blob:, ТАЙНИТ
  // canvas в Chrome → toBlob падает с SecurityError «Tainted canvases may not be
  // exported». Проверено на проде: blob → SecurityError, data-URI → PNG ok.
  const img = new Image()
  img.decoding = 'sync'
  await new Promise<void>((res, rej) => {
    img.onload = () => res()
    img.onerror = () => rej(new Error('svg render failed'))
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  })
  const canvas = document.createElement('canvas')
  canvas.width = parts.width * scale
  canvas.height = parts.height * scale
  const ctx = canvas.getContext('2d')!
  if (mime === 'image/jpeg') { ctx.fillStyle = jpegBg; ctx.fillRect(0, 0, canvas.width, canvas.height) }
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0)
  return await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => b ? res(b) : rej(new Error('toBlob null')), mime, quality))
}
