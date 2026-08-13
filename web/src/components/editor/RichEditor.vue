<script setup lang="ts">
// Rich-text редактор на TipTap с всплывающим тулбаром (bubble menu) при
// выделении: форматирование + «Спросить ИИ агента». Значение — markdown
// (tiptap-markdown), чтобы поле оставалось совместимым с system-промптом.
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Editor, EditorContent } from '@tiptap/vue-3'
import { BubbleMenu } from '@tiptap/vue-3/menus'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Markdown } from 'tiptap-markdown'
import {
  Bold, Code, Italic, List, ListOrdered, PenLine, Quote, Strikethrough,
} from 'lucide-vue-next'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  modelValue: string
  placeholder?: string
  minHeight?: number
}>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  /** «Спросить ИИ агента»: (инструкция, выделенный текст) → правка */
  (e: 'ask-ai', instruction: string, selection: string): void
}>()

const { t } = useI18n()

const editor = new Editor({
  content: props.modelValue,
  extensions: [
    StarterKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    // подсказку TipTap читает один раз при создании редактора
    Placeholder.configure({ placeholder: props.placeholder ?? t('blog.editor.rich.placeholder') }),
    Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: true }),
  ],
  editorProps: {
    attributes: {
      class: 'tiptap-body max-w-none focus:outline-none',
      style: `min-height:${props.minHeight ?? 280}px`,
    },
  },
  onUpdate: ({ editor }) => {
    emit('update:modelValue', (editor.storage as any).markdown.getMarkdown())
  },
})

// внешнее значение изменилось (загрузка/сброс) — синхронизируем без петли
watch(() => props.modelValue, (v) => {
  const cur = (editor.storage as any).markdown.getMarkdown()
  if (v !== cur) editor.commands.setContent(v, { emitUpdate: false })
})

onBeforeUnmount(() => editor.destroy())

// ── «Спросить ИИ агента» ─────────────────────────────────────────────────
const askOpen = ref(false)
const askText = ref('')
// диапазон, по которому спросили: правку вставляем ИМЕННО в него, а не ищем
// строкой по документу (строковый replace бил по первому совпадению — при
// повторяющемся фрагменте правка уезжала не туда)
let askFrom = 0
let askTo = 0
function openAsk() { askOpen.value = true; askText.value = '' }
function submitAsk() {
  const instruction = askText.value.trim()
  if (!instruction) return
  const { from, to } = editor.state.selection
  askFrom = from; askTo = to
  const selection = editor.state.doc.textBetween(from, to, ' ')
  emit('ask-ai', instruction, selection)
  askOpen.value = false
  askText.value = ''
}

/**
 * Вставить ответ ИИ транзакцией TipTap по диапазону последнего вопроса.
 * markdown разбирается расширением tiptap-markdown (insertContentAt его парсит),
 * поэтому в документ попадают нормальные ноды, а не текст с разметкой.
 * Пустой ответ = «удалить фрагмент».
 */
function applyAiEdit(markdown: string) {
  const md = markdown.trim()
  const from = Math.min(askFrom, editor.state.doc.content.size)
  const to = Math.min(askTo, editor.state.doc.content.size)
  if (from === to) { // спрашивали без выделения — правка касается всего документа
    editor.commands.setContent(md)
    emit('update:modelValue', (editor.storage as any).markdown.getMarkdown())
    return
  }
  if (!md) editor.chain().focus().deleteRange({ from, to }).run()
  else editor.chain().focus().insertContentAt({ from, to }, md).run()
}

defineExpose({ applyAiEdit })

const btn = 'flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-hover hover:text-foreground'
const active = 'bg-surface-hover text-foreground'
</script>

<template>
  <div class="rounded-2xl border border-border bg-surface">
    <BubbleMenu v-if="editor" :editor="editor" :options="{ placement: 'top' }">
      <div class="flex items-center gap-0.5 rounded-xl border border-border bg-popover/95 p-1 shadow-2xl backdrop-blur">
        <template v-if="!askOpen">
          <button :class="[btn, editor.isActive('bold') && active]" :title="$t('blog.editor.format.bold')" @click="editor.chain().focus().toggleBold().run()"><Bold :size="15" /></button>
          <button :class="[btn, editor.isActive('italic') && active]" :title="$t('blog.editor.format.italic')" @click="editor.chain().focus().toggleItalic().run()"><Italic :size="15" /></button>
          <button :class="[btn, editor.isActive('strike') && active]" :title="$t('blog.editor.format.strike')" @click="editor.chain().focus().toggleStrike().run()"><Strikethrough :size="15" /></button>
          <span class="mx-0.5 h-5 w-px bg-border"></span>
          <button :class="[btn, editor.isActive('bulletList') && active]" :title="$t('blog.editor.format.bulletList')" @click="editor.chain().focus().toggleBulletList().run()"><List :size="15" /></button>
          <button :class="[btn, editor.isActive('orderedList') && active]" :title="$t('blog.editor.format.orderedList')" @click="editor.chain().focus().toggleOrderedList().run()"><ListOrdered :size="15" /></button>
          <button :class="[btn, editor.isActive('blockquote') && active]" :title="$t('blog.editor.format.quote')" @click="editor.chain().focus().toggleBlockquote().run()"><Quote :size="15" /></button>
          <button :class="[btn, editor.isActive('codeBlock') && active]" :title="$t('blog.editor.format.code')" @click="editor.chain().focus().toggleCodeBlock().run()"><Code :size="15" /></button>
          <span class="mx-0.5 h-5 w-px bg-border"></span>
          <button
            class="flex h-8 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-[12.5px] font-medium text-background transition hover:opacity-90"
            :title="$t('blog.editor.rich.askAiTitle')" @click="openAsk"
          ><PenLine :size="14" /> {{ $t('blog.editor.rich.askAi') }}</button>
        </template>
        <div v-else class="flex items-center gap-1.5 p-0.5">
          <PenLine :size="14" class="ml-1 text-muted-foreground" />
          <Input
            v-model="askText" autofocus
            :placeholder="$t('blog.editor.rich.askPlaceholder')"
            class="h-8 w-72 border-border bg-surface-2 text-[12.5px]"
            @keydown.enter.prevent="submitAsk"
            @keydown.esc="askOpen = false"
          />
          <Button size="sm" class="h-8" :disabled="!askText.trim()" @click="submitAsk">{{ $t('blog.editor.rich.submit') }}</Button>
        </div>
      </div>
    </BubbleMenu>

    <EditorContent :editor="editor" class="px-6 py-5 sm:px-8 sm:py-6" />
  </div>
</template>

<style>
/* Profile document: clean, airy typography (LobeHub / Linear style). Colors use
   design-system tokens so the editor reads correctly in both light and dark. */
.tiptap-body {
  font-size: 14.5px;
  line-height: 1.78;
  color: var(--foreground);
  letter-spacing: -0.003em;
}
.tiptap-body:focus { outline: none; }
.tiptap-body > :first-child { margin-top: 0; }
.tiptap-body > :last-child { margin-bottom: 0; }

/* Headings: display weight + tight tracking, thin divider under h1 */
.tiptap-body h1 {
  font-size: 27px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.15;
  color: var(--foreground); margin: 1.75em 0 0.65em; padding-bottom: 0.4em;
  border-bottom: 1px solid var(--border);
}
.tiptap-body h2 { font-size: 20px; font-weight: 700; letter-spacing: -0.022em; color: var(--foreground); margin: 1.5em 0 0.55em; }
.tiptap-body h3 { font-size: 16px; font-weight: 650; letter-spacing: -0.015em; color: var(--foreground); margin: 1.25em 0 0.45em; }
.tiptap-body p { margin: 0.7em 0; }

/* Bulleted lists: tidy brand dot */
.tiptap-body ul:not([data-type="taskList"]) { list-style: none; margin: 0.7em 0; padding-left: 1.4em; }
.tiptap-body ul:not([data-type="taskList"]) > li { position: relative; }
.tiptap-body ul:not([data-type="taskList"]) > li::before {
  content: ""; position: absolute; left: -0.95em; top: 0.72em;
  width: 5px; height: 5px; border-radius: 50%; background: var(--brand-accent);
}
.tiptap-body ol { margin: 0.7em 0; padding-left: 1.6em; list-style: decimal; }
.tiptap-body ol > li::marker { color: var(--brand-accent); font-weight: 600; font-variant-numeric: tabular-nums; }
.tiptap-body li { margin: 0.4em 0; }
.tiptap-body li > p { margin: 0.15em 0; }

/* Checklist (quality gate): real checkboxes instead of "[ ]" */
.tiptap-body ul[data-type="taskList"] { list-style: none; margin: 0.7em 0; padding: 0; }
.tiptap-body ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 0.65em; margin: 0.35em 0; }
.tiptap-body ul[data-type="taskList"] li > label { flex-shrink: 0; margin-top: 0.28em; user-select: none; }
.tiptap-body ul[data-type="taskList"] li > div { flex: 1; min-width: 0; }
.tiptap-body ul[data-type="taskList"] input[type="checkbox"] {
  appearance: none; -webkit-appearance: none; width: 16px; height: 16px; margin: 0;
  border: 1.5px solid var(--border); border-radius: 5px; background: var(--surface);
  cursor: pointer; transition: all .15s; position: relative;
}
.tiptap-body ul[data-type="taskList"] input[type="checkbox"]:hover { border-color: var(--brand-accent); }
.tiptap-body ul[data-type="taskList"] input[type="checkbox"]:checked { background: var(--brand-accent); border-color: var(--brand-accent); }
.tiptap-body ul[data-type="taskList"] input[type="checkbox"]:checked::after {
  content: ""; position: absolute; left: 4.5px; top: 1.5px; width: 4px; height: 8px;
  border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
}
.tiptap-body ul[data-type="taskList"] li[data-checked="true"] > div { color: var(--muted-foreground); text-decoration: line-through; text-decoration-color: var(--border); }

.tiptap-body blockquote { border-left: 2px solid var(--brand-accent); padding-left: 1em; margin: 0.9em 0; color: var(--muted-foreground); font-style: italic; }
.tiptap-body code { background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px; padding: 1.5px 6px; font-size: 12.5px; font-family: ui-monospace, "SF Mono", Menlo, monospace; color: var(--foreground); }
.tiptap-body pre { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; margin: 0.9em 0; overflow-x: auto; }
.tiptap-body pre code { background: none; border: none; padding: 0; color: var(--foreground); }
.tiptap-body strong { font-weight: 680; color: var(--foreground); }
.tiptap-body a { color: var(--brand-accent); text-decoration: underline; text-decoration-color: var(--brand-accent-soft); text-underline-offset: 2px; }
.tiptap-body hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
.tiptap-body p.is-editor-empty:first-child::before {
  content: attr(data-placeholder); color: var(--muted-foreground); float: left; height: 0; pointer-events: none;
}
</style>