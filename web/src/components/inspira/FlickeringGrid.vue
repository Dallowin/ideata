<script setup lang="ts">
// Inspira UI — Flickering Grid: сетка квадратов, каждый мерцает своей opacity.
// Canvas на devicePixelRatio, ресайз через ResizeObserver, пауза вне вьюпорта
// и при prefers-reduced-motion. Цвет — brand (rgb), маску/затухание даёт CSS.
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{
  squareSize?: number
  gridGap?: number
  color?: string        // "r, g, b"
  maxOpacity?: number
  flickerChance?: number
}>(), {
  squareSize: 3,
  gridGap: 6,
  color: '96, 128, 255',
  maxOpacity: 0.4,
  flickerChance: 0.28,
})

const canvas = ref<HTMLCanvasElement | null>(null)
const wrap = ref<HTMLDivElement | null>(null)
let raf = 0
let ro: ResizeObserver | null = null
let io: IntersectionObserver | null = null
let visible = true
let last = 0
let squares: Float32Array = new Float32Array(0)
let cols = 0
let rows = 0
let dpr = 1

const reduce = typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function setup() {
  const c = canvas.value; const w = wrap.value
  if (!c || !w) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  const { width, height } = w.getBoundingClientRect()
  c.width = Math.floor(width * dpr)
  c.height = Math.floor(height * dpr)
  c.style.width = `${width}px`
  c.style.height = `${height}px`
  const step = props.squareSize + props.gridGap
  cols = Math.ceil(width / step)
  rows = Math.ceil(height / step)
  squares = new Float32Array(cols * rows)
  for (let i = 0; i < squares.length; i++) squares[i] = Math.random() * props.maxOpacity
}

function draw() {
  const c = canvas.value
  const ctx = c?.getContext('2d')
  if (!c || !ctx) return
  ctx.clearRect(0, 0, c.width, c.height)
  const step = (props.squareSize + props.gridGap) * dpr
  const size = props.squareSize * dpr
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const o = squares[i * rows + j]!
      ctx.fillStyle = `rgba(${props.color}, ${o})`
      ctx.fillRect(i * step, j * step, size, size)
    }
  }
}

function tick(now: number) {
  raf = requestAnimationFrame(tick)
  if (!visible) return
  const dt = (now - last) / 1000
  if (dt < 1 / 45) return
  last = now
  for (let i = 0; i < squares.length; i++) {
    if (Math.random() < props.flickerChance * dt * 6) {
      squares[i] = Math.random() * props.maxOpacity
    }
  }
  draw()
}

onMounted(() => {
  setup(); draw()
  if (reduce) return
  ro = new ResizeObserver(() => { setup(); draw() })
  if (wrap.value) ro.observe(wrap.value)
  io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting })
  if (wrap.value) io.observe(wrap.value)
  raf = requestAnimationFrame(tick)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  ro?.disconnect(); io?.disconnect()
})
</script>

<template>
  <div ref="wrap" class="absolute inset-0 h-full w-full">
    <canvas ref="canvas" class="block h-full w-full" />
  </div>
</template>
