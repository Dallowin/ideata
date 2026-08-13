/** Форматы холста. og 1200×630 — дефолт: под обложку статьи и соцпревью ссылки. */
// Подписи — ключи словаря (`preview.size.*`), переводит студия: список
// статический, а язык интерфейса меняется на лету.
export interface SizeDef { id: string; labelKey: string; hintKey: string; w: number; h: number }

const def = (id: string, w: number, h: number): SizeDef => ({
  id, w, h, labelKey: `preview.size.${id}.label`, hintKey: `preview.size.${id}.hint`,
})

export const SIZES: SizeDef[] = [
  def('og', 1200, 630),
  def('wide', 1600, 900),
  def('square', 1080, 1080),
  def('story', 1080, 1920),
  def('twitter', 1200, 675),
  def('yt', 1280, 720),
]
