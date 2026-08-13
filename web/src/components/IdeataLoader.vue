<script setup lang="ts">
// Лоадер на весь контейнер: слово «Ideata» шрифтом бренда (Geist) «рисуется»
// обводкой (stroke draw-on) → заливается → зацикливается. Как self-drawing
// логотипы у премиум-продуктов. SVG <text> — без конвертации в пути: обводка
// глифов анимируется через stroke-dashoffset.
withDefaults(defineProps<{
  /** на весь вьюпорт (fixed) вместо своего контейнера (absolute) */
  fullscreen?: boolean
  /** подпись под лого */
  label?: string
  /** 'draw' — self-drawing (для бута); 'solid' — залитый лого + пульс (для быстрых переходов) */
  variant?: 'draw' | 'solid'
}>(), { fullscreen: false, label: '', variant: 'draw' })
</script>

<template>
  <div class="ideata-loader" :class="fullscreen ? 'is-fixed' : 'is-abs'">
    <div class="wrap">
      <svg class="mark" viewBox="0 0 360 96" xmlns="http://www.w3.org/2000/svg" aria-label="Ideata">
        <text x="180" y="66" text-anchor="middle" :class="variant === 'solid' ? 'solid' : 'draw'">Ideata</text>
      </svg>
      <div class="bar"><span></span></div>
      <p v-if="label" class="cap">{{ label }}</p>
    </div>
  </div>
</template>

<style scoped>
.ideata-loader {
  display: grid;
  place-items: center;
  background: var(--background);
  color: var(--foreground);
}
.is-abs { position: absolute; inset: 0; z-index: 40; }
.is-fixed { position: fixed; inset: 0; z-index: 100; }

.wrap { display: flex; flex-direction: column; align-items: center; gap: 18px; }

.mark { width: min(320px, 62vw); height: auto; overflow: visible; }
.mark text {
  font-family: 'Bricolage Grotesque Variable', 'Geist Variable', system-ui, sans-serif;
  font-size: 68px;
  font-weight: 700;
  letter-spacing: -2px;
}

/* self-drawing (бут): обводка рисуется → заливается → ДЕРЖИТСЯ (один проход,
   без мигания). Непрерывное движение даёт полоса-прогресс снизу. */
.draw {
  fill: transparent;
  stroke: currentColor;
  stroke-width: 1.1;
  stroke-linejoin: round;
  stroke-dasharray: 820;
  stroke-dashoffset: 820;
  animation: ideata-draw 1.7s ease-in-out forwards;
}
@keyframes ideata-draw {
  0%   { stroke-dashoffset: 820; fill: transparent; opacity: 0; }
  6%   { opacity: 1; }
  58%  { stroke-dashoffset: 0; fill: transparent; }
  78%  { fill: currentColor; }
  100% { stroke-dashoffset: 0; fill: currentColor; opacity: 1; }
}

/* залитый (быстрые переходы): цельный лого + мягкий пульс, без полурисунка */
.solid {
  fill: currentColor;
  stroke: none;
  animation: ideata-pulse 1.3s ease-in-out infinite;
}
@keyframes ideata-pulse {
  0%, 100% { opacity: .5; }
  50%      { opacity: 1; }
}

/* тонкая прогресс-полоса под лого */
.bar {
  width: 132px;
  height: 2px;
  border-radius: 2px;
  background: color-mix(in oklch, var(--foreground) 12%, transparent);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  width: 40%;
  border-radius: 2px;
  background: color-mix(in oklch, var(--foreground) 55%, transparent);
  animation: ideata-bar 1.4s ease-in-out infinite;
}
@keyframes ideata-bar {
  0%   { transform: translateX(-120%); }
  100% { transform: translateX(330%); }
}

.cap { font-size: 12.5px; color: var(--muted-foreground); letter-spacing: .2px; }

@media (prefers-reduced-motion: reduce) {
  .draw { animation: none; fill: currentColor; stroke-dashoffset: 0; opacity: 1; }
  .solid { animation: none; opacity: 1; }
  .bar span { animation: none; width: 100%; }
}
</style>
