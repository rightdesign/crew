<script setup lang="ts">
// A thumbnail grid whose images open in a lightbox: previous/next buttons,
// arrow keys, swipe, Escape or a click on the backdrop to close. Without
// JavaScript each thumbnail is still a plain link to the full image.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

interface GalleryItem {
  src: string
  alt: string
  caption: string
}

const props = defineProps<{ items: GalleryItem[] }>()

const open = ref<number | null>(null)
const current = computed(() => (open.value === null ? null : props.items[open.value]))
const thumbs = ref<HTMLElement[]>([])
const closeButton = ref<HTMLElement | null>(null)
let opener: HTMLElement | null = null
let touchX: number | null = null

function show(index: number) {
  opener = thumbs.value[index] ?? null
  open.value = index
}

function close() {
  open.value = null
  opener?.focus()
}

function step(by: number) {
  if (open.value === null) return
  const count = props.items.length
  open.value = (open.value + by + count) % count
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') close()
  else if (event.key === 'ArrowRight') step(1)
  else if (event.key === 'ArrowLeft') step(-1)
  else if (event.key === 'Tab') trapFocus(event)
}

// Keep Tab inside the dialog while it is open.
function trapFocus(event: KeyboardEvent) {
  const dialog = closeButton.value?.closest('.lightbox')
  if (!dialog) return
  const stops = Array.from(dialog.querySelectorAll<HTMLElement>('button'))
  const first = stops[0]
  const last = stops[stops.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function onTouchStart(event: TouchEvent) {
  touchX = event.changedTouches[0].clientX
}

function onTouchEnd(event: TouchEvent) {
  if (touchX === null) return
  const moved = event.changedTouches[0].clientX - touchX
  touchX = null
  if (Math.abs(moved) > 50) step(moved < 0 ? 1 : -1)
}

watch(open, async (now, before) => {
  if (now !== null && before === null) {
    document.addEventListener('keydown', onKey)
    document.documentElement.style.overflow = 'hidden'
    await nextTick()
    closeButton.value?.focus()
  } else if (now === null) {
    document.removeEventListener('keydown', onKey)
    document.documentElement.style.overflow = ''
  }
})

onBeforeUnmount(() => {
  if (typeof document === 'undefined') return
  document.removeEventListener('keydown', onKey)
  document.documentElement.style.overflow = ''
})
</script>

<template>
  <div class="gallery">
    <figure v-for="(item, index) in items" :key="item.src">
      <a
        :href="item.src"
        :ref="(el) => { if (el) thumbs[index] = el as HTMLElement }"
        :aria-label="`View larger: ${item.alt}`"
        @click.prevent="show(index)"
      >
        <img :src="item.src" :alt="item.alt" loading="lazy" />
      </a>
      <figcaption>{{ item.caption }}</figcaption>
    </figure>
  </div>

  <ClientOnly>
    <Teleport to="body">
      <div
        v-if="current"
        class="lightbox"
        role="dialog"
        aria-modal="true"
        :aria-label="current.caption"
        @click.self="close"
        @touchstart.passive="onTouchStart"
        @touchend.passive="onTouchEnd"
      >
        <button ref="closeButton" class="lightbox-button lightbox-close" type="button" aria-label="Close" @click="close">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <button
          v-if="items.length > 1"
          class="lightbox-button lightbox-previous"
          type="button"
          aria-label="Previous image"
          @click="step(-1)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <figure class="lightbox-figure" @click.self="close">
          <img :key="current.src" :src="current.src" :alt="current.alt" />
          <figcaption aria-live="polite">
            <span>{{ current.caption }}</span>
            <span v-if="items.length > 1" class="lightbox-count">{{ open! + 1 }} / {{ items.length }}</span>
          </figcaption>
        </figure>
        <button
          v-if="items.length > 1"
          class="lightbox-button lightbox-next"
          type="button"
          aria-label="Next image"
          @click="step(1)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
        </button>
      </div>
    </Teleport>
  </ClientOnly>
</template>

<style scoped>
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 20px;
  margin: 16px 0;
}

.gallery figure {
  margin: 0;
}

.gallery a {
  display: block;
  cursor: zoom-in;
  border-radius: 8px;
}

.gallery img {
  width: 100%;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  transition: border-color 0.2s;
}

.gallery a:hover img,
.gallery a:focus-visible img {
  border-color: var(--vp-c-brand-1);
}

.gallery figcaption {
  margin-top: 8px;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.lightbox {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 56px 64px 24px;
  background: rgba(0, 0, 0, 0.88);
}

.lightbox-figure {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 100%;
  max-height: 100%;
  margin: 0;
}

.lightbox-figure img {
  max-width: 100%;
  max-height: calc(100vh - 150px);
  object-fit: contain;
  border-radius: 6px;
  background: #fff;
}

.lightbox-figure figcaption {
  display: flex;
  gap: 16px;
  justify-content: center;
  margin-top: 14px;
  font-size: 14px;
  line-height: 1.5;
  color: #f2f2f2;
  text-align: center;
}

.lightbox-count {
  flex: none;
  color: #a8a8a8;
  font-variant-numeric: tabular-nums;
}

.lightbox-button {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: #fff;
  background: rgba(255, 255, 255, 0.12);
  transition: background 0.2s;
}

.lightbox-button:hover {
  background: rgba(255, 255, 255, 0.28);
}

.lightbox-button:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

.lightbox-button svg {
  width: 22px;
  height: 22px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.lightbox-close {
  top: 8px;
  right: 10px;
}

.lightbox-previous {
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
}

.lightbox-next {
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
}

@media (max-width: 640px) {
  .lightbox {
    padding: 56px 8px 72px;
  }

  .lightbox-previous,
  .lightbox-next {
    top: auto;
    bottom: 14px;
    transform: none;
  }

  .lightbox-previous {
    left: calc(50% - 56px);
  }

  .lightbox-next {
    right: calc(50% - 56px);
  }

  .lightbox-figure img {
    max-height: calc(100vh - 220px);
  }
}
</style>
