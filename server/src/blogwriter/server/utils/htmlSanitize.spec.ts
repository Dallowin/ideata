/**
 * The sanitizer is the only thing standing between the editor and the public
 * blog's `v-html`, so it's covered by tests rather than a one-off smoke check:
 * any edit to the whitelists should break the build, not silently open a hole.
 */
import { sanitizeArticleHtml } from './htmlSanitize'

describe('sanitizeArticleHtml', () => {
  describe('executable content does not get through', () => {
    it('strips script along with its content', () => {
      const out = sanitizeArticleHtml('<p>до</p><script>alert(1)</script><p>после</p>')
      expect(out).not.toMatch(/script|alert/i)
      expect(out).toContain('до')
      expect(out).toContain('после')
    })

    it('strips event handlers', () => {
      const out = sanitizeArticleHtml('<p onclick="alert(1)" onmouseover="x()">текст</p>')
      expect(out).not.toMatch(/onclick|onmouseover/i)
      expect(out).toContain('текст')
    })

    it('strips javascript: in href, including obfuscated forms', () => {
      for (const href of ['javascript:alert(1)', 'java\tscript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)']) {
        const out = sanitizeArticleHtml(`<p><a href="${href}">клик</a></p>`)
        expect(out).not.toMatch(/javascript/i)
        expect(out).toContain('клик')
      }
    })

    it('disallows data: as an image source', () => {
      const out = sanitizeArticleHtml('<img src="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==">')
      expect(out).not.toContain('data:')
    })

    it('strips svg and form entirely', () => {
      const out = sanitizeArticleHtml('<svg><script>alert(1)</script></svg><form action="/x"><input name="a"></form>')
      expect(out.trim()).toBe('')
    })

    it('strips srcdoc from an iframe on an allowed host', () => {
      const out = sanitizeArticleHtml(
        '<iframe src="https://www.youtube.com/embed/X" srcdoc="<script>alert(1)</script>"></iframe>',
      )
      expect(out).not.toMatch(/srcdoc|alert/i)
      expect(out).toContain('youtube.com/embed/X')
    })
  })

  describe('iframe only from the whitelist', () => {
    it('keeps YouTube and sets safe attributes', () => {
      const out = sanitizeArticleHtml('<iframe src="https://www.youtube.com/embed/dQw4"></iframe>')
      expect(out).toContain('https://www.youtube.com/embed/dQw4')
      expect(out).toMatch(/loading="lazy"/)
      expect(out).toMatch(/allowfullscreen/)
    })

    it('removes iframe from a foreign host', () => {
      expect(sanitizeArticleHtml('<iframe src="https://evil.com/x"></iframe>').trim()).toBe('')
    })

    it('is not fooled by a host suffix', () => {
      // youtube.com.evil.com is not a subdomain of youtube.com
      expect(sanitizeArticleHtml('<iframe src="https://www.youtube.com.evil.com/embed/x"></iframe>').trim()).toBe('')
    })

    it('removes iframe over http (mixed content / MITM)', () => {
      expect(sanitizeArticleHtml('<iframe src="http://www.youtube.com/embed/x"></iframe>').trim()).toBe('')
    })
  })

  describe('editor media block survives without loss', () => {
    const figure =
      '<figure class="bw-media bw-media--embed" data-kind="embed" data-provider="youtube" '
      + 'data-src="https://www.youtube.com/embed/X" data-href="https://youtu.be/X" data-ratio="56.25">'
      + '<div class="bw-embed" style="padding-bottom:56.25%">'
      + '<iframe src="https://www.youtube.com/embed/X"></iframe></div>'
      + '<figcaption>Подпись</figcaption></figure>'

    it('preserves data-*, class, and the embed aspect ratio', () => {
      const out = sanitizeArticleHtml(figure)
      expect(out).toContain('data-kind="embed"')
      expect(out).toContain('data-ratio="56.25"')
      expect(out).toContain('padding-bottom:56.25%')
      expect(out).toContain('<figcaption>Подпись</figcaption>')
    })

    it('is idempotent - a repeat pass changes nothing', () => {
      const once = sanitizeArticleHtml(figure)
      expect(sanitizeArticleHtml(once)).toBe(once)
    })

    it('does not let padding-bottom through outside the embed container', () => {
      const out = sanitizeArticleHtml('<div class="other" style="padding-bottom:56.25%">x</div>')
      expect(out).not.toContain('padding-bottom')
    })

    it('image and video from our own path are kept', () => {
      const out = sanitizeArticleHtml(
        '<figure data-kind="image" data-src="/blogwriter/media/a.jpg"><img src="/blogwriter/media/a.jpg" alt="кот" loading="lazy"></figure>'
        + '<figure data-kind="video"><video src="/blogwriter/media/b.mp4" controls playsinline></video></figure>',
      )
      expect(out).toContain('src="/blogwriter/media/a.jpg"')
      expect(out).toContain('alt="кот"')
      expect(out).toContain('src="/blogwriter/media/b.mp4"')
      expect(out).toContain('controls')
    })

    it('removes a media tag left without a usable source', () => {
      expect(sanitizeArticleHtml('<img src="javascript:alert(1)">').trim()).toBe('')
    })

    /**
     * The markup below is what the web/ and app/ editors assemble in their node's
     * renderHTML. These tests catch a contract mismatch: if the sanitizer strips
     * anything from this set, the block silently breaks on the very next article save.
     */
    describe('attributes the editors actually set are not stripped', () => {
      const cases: Array<[string, string, string[]]> = [
        ['video', '<figure class="bw-media bw-media--video" data-kind="video" data-src="/blogwriter/media/a.mp4" data-mime="video/mp4">'
          + '<video src="/blogwriter/media/a.mp4" controls preload="metadata" playsinline></video></figure>',
        ['controls', 'preload="metadata"', 'playsinline', 'data-mime="video/mp4"']],

        ['audio', '<figure class="bw-media bw-media--audio" data-kind="audio" data-src="/blogwriter/media/a.mp3" data-name="podcast.mp3">'
          + '<audio src="/blogwriter/media/a.mp3" controls preload="metadata"></audio></figure>',
        ['controls', 'data-name="podcast.mp3"']],

        ['file', '<figure class="bw-media bw-media--file" data-kind="file" data-src="/blogwriter/media/r.pdf" data-name="report.pdf" data-size="2411008" data-mime="application/pdf">'
          + '<a class="bw-file" href="/blogwriter/media/r.pdf" target="_blank" rel="noopener" download="report.pdf">'
          + '<span class="bw-file__name">report.pdf</span><span class="bw-file__meta">PDF · 2,3 МБ</span></a></figure>',
        ['download="report.pdf"', 'class="bw-file"', 'data-size="2411008"', 'PDF · 2,3 МБ']],

        ['link card', '<figure class="bw-media bw-media--link" data-kind="link" data-href="https://example.com/x" data-title="Заголовок" data-site="example.com">'
          + '<a class="bw-linkcard" href="https://example.com/x" target="_blank" rel="noopener nofollow">'
          + '<img class="bw-linkcard__thumb" src="https://example.com/og.png" alt="" loading="lazy">'
          + '<span class="bw-linkcard__body"><span class="bw-linkcard__title">Заголовок</span>'
          + '<span class="bw-linkcard__site">example.com</span></span></a></figure>',
        ['class="bw-linkcard"', 'nofollow', 'loading="lazy"', 'data-title="Заголовок"']],

        ['full-width image', '<figure class="bw-media bw-media--image" data-kind="image" data-align="full" data-src="/blogwriter/media/a.jpg" data-width="1600" data-height="900">'
          + '<img src="/blogwriter/media/a.jpg" alt="" loading="lazy"><figcaption>Подпись</figcaption></figure>',
        ['data-align="full"', 'data-width="1600"', '<figcaption>Подпись</figcaption>']],
      ]

      it.each(cases)('%s', (_name, html, expected) => {
        const out = sanitizeArticleHtml(html)
        for (const fragment of expected) expect(out).toContain(fragment)
        // and re-saving doesn't strip anything away
        expect(sanitizeArticleHtml(out)).toBe(out)
      })
    })
  })

  describe('existing articles do not degrade', () => {
    it('regular TipTap markup passes through unchanged', () => {
      const html =
        '<h2>Заголовок</h2><p>Текст со <strong>жирным</strong> и <em>курсивом</em>, '
        + '<a href="https://ideata.io/blog">ссылкой</a>.</p>'
        + '<ul><li>раз</li><li>два</li></ul><ol start="3"><li>три</li></ol>'
        + '<blockquote><p>цитата</p></blockquote><pre><code>code()</code></pre><hr>'
      expect(sanitizeArticleHtml(html)).toBe(html)
    })

    it('table preserves column widths', () => {
      const html =
        '<table><colgroup><col style="width:120px"></colgroup>'
        + '<tbody><tr><th colspan="2">Шапка</th></tr><tr><td colwidth="120">Ячейка</td><td>Ещё</td></tr></tbody></table>'
      const out = sanitizeArticleHtml(html)
      expect(out).toContain('<colgroup>')
      expect(out).toContain('width:120px')
      expect(out).toContain('colspan="2"')
      expect(out).toContain('colwidth="120"')
    })

    it('h5/h6 are not turned into plain text', () => {
      const out = sanitizeArticleHtml('<h5>пять</h5><h6>шесть</h6>')
      expect(out).toContain('<h5>пять</h5>')
      expect(out).toContain('<h6>шесть</h6>')
    })

    it('target=_blank gets noopener', () => {
      const out = sanitizeArticleHtml('<a href="https://example.com" target="_blank">x</a>')
      expect(out).toMatch(/rel="[^"]*noopener/)
    })

    it('unknown tag is unwrapped, not removed along with its text', () => {
      expect(sanitizeArticleHtml('<section><p>важный текст</p></section>')).toContain('важный текст')
    })

    it('empty and garbage input do not crash', () => {
      expect(sanitizeArticleHtml('')).toBe('')
      expect(sanitizeArticleHtml('   ')).toBe('')
      expect(sanitizeArticleHtml(null as any)).toBe('')
      expect(sanitizeArticleHtml('<p>не закрыт')).toContain('не закрыт')
    })
  })
})
