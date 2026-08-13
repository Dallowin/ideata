// Единственная нода на все виды медиа в теле статьи: картинка, видео, аудио,
// файл, встраивание (YouTube/VK/…) и карточка ссылки. Один узел вместо пяти —
// потому что HTML-контракт один (<figure data-kind=…>), а различия сводятся к
// внутренней разметке; так же проще санитайзеру и публичному рендеру.
//
// Источник истины при парсинге — data-*-атрибуты на <figure>. Внутренняя
// разметка производная: её мы всегда пересобираем сами, поэтому чужой/битый
// HTML внутри figure не переживает круг «сохранить → открыть».
import { Node, VueNodeViewRenderer } from '@tiptap/vue-3'
import type { DOMOutputSpec } from '@tiptap/pm/model'
import MediaView from './MediaView.vue'

export type MediaKindAll = 'image' | 'video' | 'audio' | 'file' | 'embed' | 'link'
export type MediaAlign = 'center' | 'wide' | 'full'

export interface MediaAttrs {
  kind: MediaKindAll
  src: string
  href: string
  alt: string
  caption: string
  title: string
  desc: string
  thumb: string
  site: string
  provider: string
  mime: string
  name: string
  size: number | null
  width: number | null
  height: number | null
  ratio: number | null
  align: MediaAlign
  /** служебные, в HTML не попадают: жизнь блока во время загрузки */
  uploading: boolean
  progress: number
  uploadError: string
  /** метка незавершённой загрузки: по ней находим ноду, когда файл долетел */
  uploadId: string
}

const ALIGNS: MediaAlign[] = ['center', 'wide', 'full']
const IFRAME_ALLOW = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen'

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}
/** пустой/неизвестный align — center (контракт, раздел 1) */
function align(v: unknown): MediaAlign {
  const s = str(v) as MediaAlign
  return ALIGNS.includes(s) ? s : 'center'
}

/** «PDF · 2,3 МБ» под именем файла — та же подпись, что рисует NodeView */
function fileMeta(a: MediaAttrs): string {
  const ext = (a.name || a.src).toLowerCase().match(/\.([a-z0-9]{1,6})(?:$|\?)/)?.[1] || ''
  const bytes = a.size || 0
  const size = !bytes
    ? ''
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} КБ`
      : `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} МБ`
  return [ext.toUpperCase(), size].filter(Boolean).join(' · ')
}

/**
 * Сериализация ровно по разделу 1 контракта. Её результат уходит и в
 * editor.getHTML() (то есть в body_html), и в публичный рендер, поэтому здесь
 * никакой «редакторской» разметки быть не должно.
 */
export function mediaToDOM(attrs: Partial<MediaAttrs>): DOMOutputSpec {
  const a = { ...attrs } as MediaAttrs
  const kind: MediaKindAll = (a.kind || 'image') as MediaKindAll
  // blob: — локальное превью незавершённой загрузки. В body_html ему делать
  // нечего: сохранение посреди загрузки иначе записало бы мёртвую ссылку
  const rawSrc = str(a.src)
  const src = rawSrc.startsWith('blob:') ? '' : rawSrc
  const href = str(a.href)
  const caption = str(a.caption).trim()

  const figure: Record<string, string> = {
    class: `bw-media bw-media--${kind}`,
    'data-kind': kind,
  }
  // data-align кладём только когда он что-то меняет — иначе шумим в HTML
  if (align(a.align) !== 'center') figure['data-align'] = align(a.align)
  if (src) figure['data-src'] = src
  if (href) figure['data-href'] = href
  if (caption) figure['data-caption'] = caption
  for (const k of ['title', 'desc', 'thumb', 'site', 'provider', 'mime', 'name'] as const) {
    const v = str(a[k]).trim()
    if (v) figure[`data-${k}`] = v
  }
  for (const k of ['size', 'width', 'height', 'ratio'] as const) {
    const v = num(a[k])
    if (v !== null) figure[`data-${k}`] = String(v)
  }

  const cap: DOMOutputSpec[] = caption ? [['figcaption', {}, caption]] : []

  if (kind === 'video')
    return ['figure', figure, ['video', { src, controls: '', preload: 'metadata', playsinline: '' }], ...cap] as DOMOutputSpec

  if (kind === 'audio')
    return ['figure', figure, ['audio', { src, controls: '', preload: 'metadata' }], ...cap] as DOMOutputSpec

  if (kind === 'embed') {
    const ratio = num(a.ratio) ?? 56.25
    return ['figure', figure, [
      'div', { class: 'bw-embed', style: `padding-bottom:${ratio}%` },
      ['iframe', {
        src,
        ...(str(a.title) ? { title: str(a.title) } : {}),
        loading: 'lazy',
        frameborder: '0',
        allow: IFRAME_ALLOW,
        allowfullscreen: '',
      }],
    ], ...cap] as DOMOutputSpec
  }

  if (kind === 'file') {
    const name = str(a.name) || 'файл'
    return ['figure', figure, [
      'a', { class: 'bw-file', href: src || href, target: '_blank', rel: 'noopener', download: name },
      ['span', { class: 'bw-file__name' }, name],
      ['span', { class: 'bw-file__meta' }, fileMeta(a)],
    ], ...cap] as DOMOutputSpec
  }

  if (kind === 'link') {
    const body: DOMOutputSpec[] = [['span', { class: 'bw-linkcard__title' }, str(a.title) || str(a.site) || href]]
    if (str(a.desc)) body.push(['span', { class: 'bw-linkcard__desc' }, str(a.desc)])
    if (str(a.site)) body.push(['span', { class: 'bw-linkcard__site' }, str(a.site)])
    const inner: DOMOutputSpec[] = []
    if (str(a.thumb)) inner.push(['img', { class: 'bw-linkcard__thumb', src: str(a.thumb), alt: '', loading: 'lazy' }])
    inner.push(['span', { class: 'bw-linkcard__body' }, ...body])
    return ['figure', figure, [
      'a', { class: 'bw-linkcard', href, target: '_blank', rel: 'noopener nofollow' }, ...inner,
    ], ...cap] as DOMOutputSpec
  }

  // image — дефолт: alt пустой, но атрибут нужен для доступности
  return ['figure', figure, ['img', { src, alt: str(a.alt) || caption, loading: 'lazy' }], ...cap] as DOMOutputSpec
}

export interface MediaOptions {
  /** ран, в который грузятся файлы; NodeView берёт его из storage (см. ниже) */
  runId: string
}
export interface MediaStorage {
  /** runId живёт в storage, а не только в options: при смене локали статья
      перезагружается на том же инстансе редактора, и опции уже не переписать */
  runId: string
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    media: {
      /** вставить медиа-блок на месте курсора */
      setMedia: (attrs: Partial<MediaAttrs>) => ReturnType
    }
  }
  interface Storage {
    media: MediaStorage
  }
}

export const Media = Node.create<MediaOptions, MediaStorage>({
  name: 'media',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { runId: '' }
  },
  addStorage() {
    return { runId: '' }
  },

  addAttributes() {
    return {
      kind: { default: 'image' },
      src: { default: '' },
      href: { default: '' },
      alt: { default: '' },
      caption: { default: '' },
      title: { default: '' },
      desc: { default: '' },
      thumb: { default: '' },
      site: { default: '' },
      provider: { default: '' },
      mime: { default: '' },
      name: { default: '' },
      size: { default: null },
      width: { default: null },
      height: { default: null },
      ratio: { default: null },
      align: { default: 'center' },
      // служебные: rendered:false — иначе уедут в body_html и в публичный рендер
      uploading: { default: false, rendered: false },
      progress: { default: 0, rendered: false },
      uploadError: { default: '', rendered: false },
      uploadId: { default: '', rendered: false },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-kind]',
        // priority выше дефолтной (50): иначе StarterKit разберёт содержимое
        // figure на абзацы и потеряет всё, кроме текста подписи
        priority: 60,
        getAttrs: (el) => {
          const e = el as HTMLElement
          const d = (n: string) => e.getAttribute(`data-${n}`) || ''
          const kind = (d('kind') || 'image') as MediaKindAll
          const inner = e.querySelector('img, video, audio, iframe, a') as HTMLElement | null
          return {
            kind,
            // data-src — истина; но чужой HTML мог прийти и без зеркал
            src: d('src') || inner?.getAttribute('src') || '',
            href: d('href') || (inner?.tagName === 'A' ? inner.getAttribute('href') || '' : ''),
            alt: e.querySelector('img')?.getAttribute('alt') || '',
            caption: d('caption') || e.querySelector('figcaption')?.textContent?.trim() || '',
            title: d('title'),
            desc: d('desc'),
            thumb: d('thumb'),
            site: d('site'),
            provider: d('provider'),
            mime: d('mime'),
            name: d('name'),
            size: num(d('size')),
            width: num(d('width')),
            height: num(d('height')),
            ratio: num(d('ratio')),
            align: align(d('align')),
          }
        },
      },
      {
        // Одиночная картинка из вставленного извне HTML: без этого правила
        // StarterKit (в нём нет ноды image) молча выбрасывает <img>.
        tag: 'img[src]',
        priority: 20,
        getAttrs: (el) => {
          const e = el as HTMLElement
          const src = e.getAttribute('src') || ''
          // data:-картинки не поддерживаем — санитайзер их всё равно снесёт
          if (!src || src.startsWith('data:')) return false
          return { kind: 'image', src, alt: e.getAttribute('alt') || '' }
        },
      },
    ]
  },

  renderHTML({ node }) {
    return mediaToDOM(node.attrs as Partial<MediaAttrs>)
  },

  addCommands() {
    return {
      setMedia:
        (attrs) =>
          ({ commands }) =>
            commands.insertContent({ type: this.name, attrs }),
    }
  },

  addNodeView() {
    return VueNodeViewRenderer(MediaView)
  },
})

export default Media
