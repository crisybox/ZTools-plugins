<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  BookOpen,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Library,
  List,
  MoreVertical,
  Pause,
  Play,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  Upload,
  X
} from '@lucide/vue'
import { decodeTextBytes } from './textDecoder'

type Chapter = {
  title: string
  index: number
}

type PageSlice = {
  text: string
  lines: string[]
  endIndex: number
}

type Book = {
  id: string
  title: string
  sourceName: string
  path?: string
  content: string
  createdAt: number
  updatedAt: number
  progressIndex: number
  size: number
  mtime?: number
}

type FishSkin = 'statusbar' | 'code' | 'terminal'
type FishSkinBackgrounds = Record<FishSkin, string>

type ReaderSettings = {
  theme: 'work' | 'paper' | 'night' | 'transparent'
  fishSkin: FishSkin
  fishBackgrounds: FishSkinBackgrounds
  fontSize: number
  lineHeight: number
  fishWidth: number
  fishHeight: number
  fishX: number | null
  fishY: number | null
  letterSpacing: number
  opacity: number
  autoSeconds: number
  prevPageKey: string
  nextPageKey: string
  stealth: boolean
  showFishPrefix: boolean
  showFishMeta: boolean
  hideOnMouseLeave: boolean
  wheelTurnPage: boolean
}

type Panel = 'library' | 'chapters' | 'search' | 'settings'
type PageKeyAction = 'prev' | 'next'

type FishCommand = string | { type?: string; width?: number; height?: number; x?: number; y?: number }
type FishBounds = { x: number; y: number; width: number; height: number }

const LIBRARY_KEY = 'deepread.library.v1'
const SETTINGS_KEY = 'deepread.settings.v1'
const LAST_BOOK_KEY = 'deepread.lastBookId.v1'
const AUTO_HIDE_MIGRATION_KEY = 'deepread.autoHideDefaulted.v1'
const STEALTH_DEFAULT_MIGRATION_KEY = 'deepread.stealthDefaulted.v1'
const FISH_MIN_WIDTH = 280
const FISH_MAX_WIDTH = 1180
const FISH_MIN_HEIGHT = 22
const FISH_MAX_HEIGHT = 160
const THEMES: ReaderSettings['theme'][] = ['work', 'paper', 'night', 'transparent']
const FISH_SKINS: FishSkin[] = ['code', 'statusbar', 'terminal']
const DEFAULT_FISH_BACKGROUNDS: FishSkinBackgrounds = {
  statusbar: '#f4f5f5',
  code: '#1e1f22',
  terminal: '#0c1011'
}

const defaultSettings: ReaderSettings = {
  theme: 'transparent',
  fishSkin: 'code',
  fishBackgrounds: { ...DEFAULT_FISH_BACKGROUNDS },
  fontSize: 13,
  lineHeight: 1.35,
  fishWidth: 700,
  fishHeight: 100,
  fishX: null,
  fishY: null,
  letterSpacing: 0,
  opacity: 82,
  autoSeconds: 12,
  prevPageKey: 'ArrowLeft',
  nextPageKey: 'ArrowRight',
  stealth: false,
  showFishPrefix: false,
  showFishMeta: false,
  hideOnMouseLeave: true,
  wheelTurnPage: true
}

const books = ref<Book[]>([])
const activeBookId = ref('')
const activePanel = ref<Panel>('library')
const searchText = ref('')
const searchCursor = ref(0)
const isReaderHidden = ref(false)
const isAutoPaging = ref(false)
const isDragging = ref(false)
const isFishKeyboardActive = ref(false)
const keyBindingCapture = ref<PageKeyAction | null>(null)
const importError = ref('')
const contextMenu = reactive({
  show: false,
  bookId: '',
  x: 0,
  y: 0
})
const settings = reactive<ReaderSettings>({
  ...defaultSettings,
  fishBackgrounds: { ...defaultSettings.fishBackgrounds }
})
const fileInputRef = ref<HTMLInputElement | null>(null)

let autoTimer = 0
let wheelLock = false
let dragDepth = 0
let fishWindowAnchor: { x: number; y: number } | null = null
let fishWindow:
  | {
      id: number
      show?: () => void
      hide?: () => void
      close?: () => void
      focus?: () => void
      blur?: () => void
      isDestroyed?: () => boolean
      setFocusable?: (flag: boolean) => void
      setSkipTaskbar?: (flag: boolean) => void
      setSize?: (width: number, height: number) => void
      setContentSize?: (width: number, height: number) => void
      setContentBounds?: (bounds: FishBounds) => void
      setPosition?: (x: number, y: number) => void
      setAlwaysOnTop?: (flag: boolean) => void
      moveTop?: () => void
      webContents?: {
        executeJavaScript?: <T = unknown>(code: string, userGesture?: boolean) => Promise<T>
      }
    }
  | null = null
let offFishCommand: (() => void) | undefined

const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const zStorage = window.ztools?.dbStorage
      const stored = zStorage?.getItem?.(key)
      if (stored !== undefined && stored !== null && stored !== '') {
        if (typeof stored !== 'string') return stored as T

        try {
          return JSON.parse(stored) as T
        } catch (error) {
          return stored as T
        }
      }

      const raw = window.localStorage.getItem(key)
      if (raw === null || raw === '') return fallback
      return JSON.parse(raw) as T
    } catch (error) {
      return fallback
    }
  },

  set(key: string, value: unknown) {
    try {
      const zStorage = window.ztools?.dbStorage
      if (zStorage?.setItem) {
        zStorage.setItem(key, value)
      } else {
        window.localStorage.setItem(key, JSON.stringify(value))
      }
    } catch (error) {
      console.warn('[DeepRead] save failed', error)
    }
  }
}

const fishLineLength = computed(() => {
  const sideControlsWidth = 44
  const contentPadding = settings.fishSkin === 'statusbar' ? 16 : 20
  const prefixWidth = settings.showFishPrefix ? (settings.fishSkin === 'statusbar' ? 42 : 24) : 0
  const readableWidth = Math.max(24, settings.fishWidth - sideControlsWidth - contentPadding - prefixWidth)
  const cjkCharacterWidth = Math.max(1, settings.fontSize + settings.letterSpacing)

  return Math.max(1, Math.floor(readableWidth / cjkCharacterWidth))
})

const fishLineCount = computed(() => {
  const linePx = settings.fontSize * settings.lineHeight
  return Math.max(1, Math.floor(Math.max(18, settings.fishHeight - 6) / Math.max(12, linePx)))
})

const activeBook = computed(() => books.value.find((book) => book.id === activeBookId.value) ?? null)

function getEmptyPageSlice(): PageSlice {
  return { text: '', lines: [], endIndex: 0 }
}

function getVisualPage(content: string, startIndex: number, lineLength: number, lineCount: number): PageSlice {
  const safeLineLength = Math.max(1, Math.round(lineLength))
  const safeLineCount = Math.max(1, Math.round(lineCount))
  const start = clampNumber(startIndex, 0, content.length)
  const lines: string[] = []
  let cursor = start

  while (cursor < content.length && lines.length < safeLineCount) {
    let line = ''
    let columns = 0

    while (cursor < content.length && columns < safeLineLength) {
      const char = content[cursor]
      if (char === '\n') {
        cursor += 1
        break
      }

      line += char
      cursor += 1
      columns += 1
    }

    if (columns >= safeLineLength && content[cursor] === '\n') {
      cursor += 1
    }

    lines.push(line)
  }

  return {
    text: content.slice(start, cursor),
    lines,
    endIndex: cursor
  }
}

function buildPageStarts(content: string, lineLength: number, lineCount: number) {
  const safeLineLength = Math.max(1, Math.round(lineLength))
  const safeLineCount = Math.max(1, Math.round(lineCount))
  const starts = [0]
  let cursor = 0

  while (cursor < content.length) {
    const startCursor = cursor
    let lines = 0

    // This path runs for the whole book during re-pagination, so keep it allocation-free.
    while (cursor < content.length && lines < safeLineCount) {
      let columns = 0

      while (cursor < content.length && columns < safeLineLength) {
        if (content[cursor] === '\n') {
          cursor += 1
          break
        }

        cursor += 1
        columns += 1
      }

      if (columns >= safeLineLength && content[cursor] === '\n') {
        cursor += 1
      }

      lines += 1
    }

    if (cursor <= startCursor) break
    if (cursor < content.length) starts.push(cursor)
  }

  return starts
}

function getMaxVisualPageStart(content: string, lineLength: number, lineCount: number) {
  return buildPageStarts(content, lineLength, lineCount).at(-1) ?? 0
}

function getPageIndexForStart(index: number, starts: number[]) {
  let low = 0
  let high = Math.max(0, starts.length - 1)
  let result = 0

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (starts[mid] <= index) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return result
}

function getPreviousPageStart(index: number, starts: number[]) {
  const pageIndex = getPageIndexForStart(index, starts)
  if (starts[pageIndex] === index) return starts[Math.max(0, pageIndex - 1)] ?? 0
  return starts[pageIndex] ?? 0
}

function getProgressPercent(progressIndex: number, contentLength: number, maxPageStart: number) {
  if (contentLength <= 0) return 0
  if (maxPageStart <= 0) return 100

  const safeIndex = clampNumber(progressIndex, 0, maxPageStart)
  return Math.round((safeIndex / maxPageStart) * 1000) / 10
}

function getApproxMaxPageStart(contentLength: number) {
  return Math.max(0, contentLength - fishLineLength.value * fishLineCount.value)
}

const activePageStarts = computed(() => {
  if (!activeBook.value) return [0]
  return buildPageStarts(activeBook.value.content, fishLineLength.value, fishLineCount.value)
})

const activeMaxPageStart = computed(() => activePageStarts.value.at(-1) ?? 0)

const pageCount = computed(() => {
  if (!activeBook.value) return 0
  return activePageStarts.value.length
})

const currentIndex = computed(() => {
  if (!activeBook.value) return 0
  return clampNumber(activeBook.value.progressIndex, 0, activeMaxPageStart.value)
})

const currentPage = computed(() => {
  if (!activeBook.value) return 0
  return getPageIndexForStart(currentIndex.value, activePageStarts.value)
})

const currentPageSlice = computed(() => {
  if (!activeBook.value) return getEmptyPageSlice()
  return getVisualPage(activeBook.value.content, currentIndex.value, fishLineLength.value, fishLineCount.value)
})

const currentText = computed(() => currentPageSlice.value.text)

const chapters = computed<Chapter[]>(() => {
  const book = activeBook.value
  if (!book) return []

  const found: Chapter[] = []
  const chapterPattern =
    /(^|\n)\s*((第[零一二三四五六七八九十百千万\d]{1,8}[章章节回卷集部篇幕][^\n]{0,36})|(楔子|序章|引子|前言|尾声|番外[^\n]{0,28}))\s*(?=\n|$)/g
  let match: RegExpExecArray | null

  while ((match = chapterPattern.exec(book.content)) !== null) {
    const title = (match[2] || '').trim()
    if (title) {
      found.push({ title, index: match.index + (match[1] ? 1 : 0) })
    }
  }

  if (!found.length) {
    return [{ title: book.title, index: 0 }]
  }

  return found.slice(0, 1000)
})

const currentChapter = computed(() => {
  const book = activeBook.value
  if (!book) return null
  const index = currentIndex.value
  return [...chapters.value].reverse().find((chapter) => chapter.index <= index) ?? chapters.value[0]
})

const searchMatches = computed(() => {
  const book = activeBook.value
  const term = searchText.value.trim()
  if (!book || term.length < 1) return []

  const matches: number[] = []
  const lowerContent = book.content.toLocaleLowerCase()
  const lowerTerm = term.toLocaleLowerCase()
  let cursor = 0

  while (matches.length < 80) {
    const index = lowerContent.indexOf(lowerTerm, cursor)
    if (index === -1) break
    matches.push(index)
    cursor = index + Math.max(1, lowerTerm.length)
  }

  return matches
})

const progressLabel = computed(() => {
  if (!activeBook.value) return '0%'
  return `${getProgressPercent(currentIndex.value, activeBook.value.content.length, activeMaxPageStart.value)}%`
})

function getBookProgressPercent(book: Book) {
  const maxPageStart = book.id === activeBookId.value ? activeMaxPageStart.value : getApproxMaxPageStart(book.content.length)
  return getProgressPercent(book.progressIndex, book.content.length, maxPageStart)
}

const sortedBooks = computed(() =>
  [...books.value].sort((a, b) => {
    if (a.id === activeBookId.value) return -1
    if (b.id === activeBookId.value) return 1
    return b.updatedAt - a.updatedAt
  })
)

const shellTitle = computed(() => (settings.stealth ? '项目资料审阅' : 'DeepRead 深读'))

const shellSubtitle = computed(() => {
  if (!activeBook.value) return 'Library'
  return settings.stealth ? currentChapter.value?.title ?? 'Document' : activeBook.value.title
})

const readerStyle = computed(() => ({
  '--reader-font-size': `${settings.fontSize}px`,
  '--reader-line-height': String(settings.lineHeight),
  '--reader-opacity': `${settings.opacity / 100}`,
  '--fish-width': `${settings.fishWidth}px`,
  '--fish-height': `${settings.fishHeight}px`,
  '--fish-letter-spacing': `${settings.letterSpacing}px`
}))

const activeBookLabel = computed(() => activeBook.value?.title ?? '未选择书籍')

const fishLines = computed(() => {
  if (currentPageSlice.value.lines.length) {
    return currentPageSlice.value.lines
  }

  return ['导入一本书后，DeepRead 会在这里显示摸鱼阅读文本。']
})

function persistLibrary() {
  storage.set(LIBRARY_KEY, books.value)
}

function persistSettings() {
  storage.set(SETTINGS_KEY, settings)
}

function loadState() {
  Object.assign(settings, normalizeSettings(storage.get<Partial<ReaderSettings>>(SETTINGS_KEY, {})))
  books.value = normalizeBooks(storage.get<unknown>(LIBRARY_KEY, []))
  persistLibrary()
  if (!storage.get<boolean>(AUTO_HIDE_MIGRATION_KEY, false)) {
    settings.hideOnMouseLeave = true
    storage.set(AUTO_HIDE_MIGRATION_KEY, true)
    persistSettings()
  }
  if (!storage.get<boolean>(STEALTH_DEFAULT_MIGRATION_KEY, false)) {
    settings.stealth = false
    storage.set(STEALTH_DEFAULT_MIGRATION_KEY, true)
    persistSettings()
  }
  const lastBookId = storage.get<string>(LAST_BOOK_KEY, '')
  activeBookId.value = books.value.some((book) => book.id === lastBookId) ? lastBookId : books.value[0]?.id || ''
}

function notify(message: string) {
  try {
    window.ztools?.showNotification?.(message, 'DeepRead 深读')
  } catch (error) {
    console.info(message)
  }
}

function normalizeTitle(name: string) {
  return name.replace(/\.(txt|md)$/i, '').replace(/[_-]+/g, ' ').trim() || '未命名书籍'
}

function getBookColorClass(title: string) {
  let hash = 0
  for (let i = 0; i < title.length; i++) {
    hash = title.charCodeAt(i) + ((hash << 5) - hash)
  }
  const index = Math.abs(hash) % 8
  return `book-color-${index}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTheme(value: unknown): value is ReaderSettings['theme'] {
  return typeof value === 'string' && THEMES.includes(value as ReaderSettings['theme'])
}

function isFishSkin(value: unknown): value is FishSkin {
  return typeof value === 'string' && FISH_SKINS.includes(value as FishSkin)
}

function toFiniteNumber(value: unknown, fallback: number) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

function toBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function normalizeKeyboardKey(key: string) {
  if (key === ' ') return 'Space'

  const trimmed = key.trim()
  const lower = trimmed.toLowerCase()
  const aliases: Record<string, string> = {
    esc: 'Escape',
    return: 'Enter',
    space: 'Space',
    spacebar: 'Space',
    up: 'ArrowUp',
    right: 'ArrowRight',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    arrowup: 'ArrowUp',
    arrowright: 'ArrowRight',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    pageup: 'PageUp',
    pagedown: 'PageDown'
  }

  if (!trimmed) return ''
  if (trimmed === '+') return 'Plus'
  if (trimmed === '-') return 'Minus'
  if (trimmed === '=') return 'Equal'
  if (/^f\d{1,2}$/i.test(trimmed)) return trimmed.toUpperCase()
  if (trimmed.length === 1) return trimmed.toUpperCase()
  return aliases[lower] ?? trimmed
}

function normalizeKeyBinding(value: unknown, fallback: string) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean)
  const key = normalizeKeyboardKey(parts.at(-1) ?? '')
  const modifiers = new Set<string>()

  for (const part of parts.slice(0, -1)) {
    const lower = part.toLowerCase()
    if (lower === 'control' || lower === 'ctrl') modifiers.add('Ctrl')
    else if (lower === 'option' || lower === 'alt') modifiers.add('Alt')
    else if (lower === 'shift') modifiers.add('Shift')
    else if (lower === 'command' || lower === 'cmd' || lower === 'meta') modifiers.add('Meta')
  }

  if (!key || ['Control', 'Shift', 'Alt', 'Meta', 'Dead', 'Process'].includes(key)) return fallback
  return [...modifiers, key].join('+')
}

function getKeyboardEventBinding(event: KeyboardEvent) {
  if (event.isComposing) return ''

  const key = normalizeKeyboardKey(event.key)
  if (!key || ['Control', 'Shift', 'Alt', 'Meta', 'Dead', 'Process'].includes(key)) return ''

  return [
    event.ctrlKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    event.metaKey ? 'Meta' : '',
    key
  ]
    .filter(Boolean)
    .join('+')
}

function getKeyBindingLabel(binding: string) {
  const labels: Record<string, string> = {
    ArrowLeft: '<',
    ArrowRight: '>',
    ArrowUp: '^',
    ArrowDown: 'v',
    Escape: 'Esc',
    Space: 'Space',
    Plus: '+',
    Minus: '-',
    Equal: '='
  }

  return normalizeKeyBinding(binding, defaultSettings.nextPageKey)
    .split('+')
    .map((part) => labels[part] ?? part)
    .join(' + ')
}

function isKeyboardShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  )
}

function hasCommandModifier(event: KeyboardEvent) {
  return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
}

function clampFloat(value: unknown, min: number, max: number, fallback: number, precision = 2) {
  const multiplier = 10 ** precision
  const safeValue = Math.min(max, Math.max(min, toFiniteNumber(value, fallback)))
  return Math.round(safeValue * multiplier) / multiplier
}

function normalizeHexColor(value: unknown, fallback: string) {
  const color = typeof value === 'string' ? value.trim() : ''
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase()

  if (/^#[0-9a-f]{3}$/i.test(color)) {
    const [, r, g, b] = color.toLowerCase()
    return `#${r}${r}${g}${g}${b}${b}`
  }

  return fallback
}

function normalizeFishBackgrounds(input: unknown): FishSkinBackgrounds {
  const stored = isRecord(input) ? input : {}

  return {
    statusbar: normalizeHexColor(stored.statusbar, DEFAULT_FISH_BACKGROUNDS.statusbar),
    code: normalizeHexColor(stored.code, DEFAULT_FISH_BACKGROUNDS.code),
    terminal: normalizeHexColor(stored.terminal, DEFAULT_FISH_BACKGROUNDS.terminal)
  }
}

function normalizeSettings(input: unknown): ReaderSettings {
  const stored = isRecord(input) ? input : {}
  const storedFishX = toFiniteNumber(stored.fishX, Number.NaN)
  const storedFishY = toFiniteNumber(stored.fishY, Number.NaN)
  const prevPageKey = normalizeKeyBinding(stored.prevPageKey, defaultSettings.prevPageKey)
  const normalizedNextPageKey = normalizeKeyBinding(stored.nextPageKey, defaultSettings.nextPageKey)
  const nextPageKey =
    normalizedNextPageKey === prevPageKey
      ? prevPageKey === defaultSettings.nextPageKey
        ? defaultSettings.prevPageKey
        : defaultSettings.nextPageKey
      : normalizedNextPageKey

  return {
    theme: isTheme(stored.theme) ? stored.theme : defaultSettings.theme,
    fishSkin: isFishSkin(stored.fishSkin) ? stored.fishSkin : defaultSettings.fishSkin,
    fishBackgrounds: normalizeFishBackgrounds(stored.fishBackgrounds),
    fontSize: clampNumber(toFiniteNumber(stored.fontSize, defaultSettings.fontSize), 10, 20),
    lineHeight: clampFloat(stored.lineHeight, 1.05, 1.8, defaultSettings.lineHeight),
    fishWidth: clampNumber(toFiniteNumber(stored.fishWidth, defaultSettings.fishWidth), FISH_MIN_WIDTH, FISH_MAX_WIDTH),
    fishHeight: clampNumber(toFiniteNumber(stored.fishHeight, defaultSettings.fishHeight), FISH_MIN_HEIGHT, FISH_MAX_HEIGHT),
    fishX: Number.isFinite(storedFishX) ? storedFishX : defaultSettings.fishX,
    fishY: Number.isFinite(storedFishY) ? storedFishY : defaultSettings.fishY,
    letterSpacing: clampFloat(stored.letterSpacing, 0, 3, defaultSettings.letterSpacing, 1),
    opacity: clampNumber(toFiniteNumber(stored.opacity, defaultSettings.opacity), 0, 100),
    autoSeconds: clampNumber(toFiniteNumber(stored.autoSeconds, defaultSettings.autoSeconds), 3, 60),
    prevPageKey,
    nextPageKey,
    stealth: toBoolean(stored.stealth, defaultSettings.stealth),
    showFishPrefix: toBoolean(stored.showFishPrefix, defaultSettings.showFishPrefix),
    showFishMeta: toBoolean(stored.showFishMeta, defaultSettings.showFishMeta),
    hideOnMouseLeave: toBoolean(stored.hideOnMouseLeave, defaultSettings.hideOnMouseLeave),
    wheelTurnPage: toBoolean(stored.wheelTurnPage, defaultSettings.wheelTurnPage)
  }
}

function normalizeBooks(input: unknown) {
  if (!Array.isArray(input)) return []

  const seenIds = new Set<string>()
  const normalized: Book[] = []

  for (const item of input) {
    const book = normalizeBook(item)
    if (!book || seenIds.has(book.id)) continue

    seenIds.add(book.id)
    normalized.push(book)
  }

  return normalized
}

function normalizeBook(input: unknown): Book | null {
  if (!isRecord(input) || typeof input.id !== 'string' || !input.id.trim() || typeof input.content !== 'string') {
    return null
  }

  const sourceName = typeof input.sourceName === 'string' && input.sourceName.trim() ? input.sourceName.trim() : '未命名书籍'
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : normalizeTitle(sourceName)
  const createdAt = toFiniteNumber(input.createdAt, Date.now())
  const updatedAt = toFiniteNumber(input.updatedAt, createdAt)
  const size = Math.max(0, toFiniteNumber(input.size, input.content.length))
  const mtime = toFiniteNumber(input.mtime, Number.NaN)

  return {
    id: input.id.trim(),
    title,
    sourceName,
    path: typeof input.path === 'string' && input.path.trim() ? input.path : undefined,
    content: input.content,
    createdAt,
    updatedAt,
    progressIndex: clampNumber(
      toFiniteNumber(input.progressIndex, 0),
      0,
      getApproxMaxPageStart(input.content.length)
    ),
    size,
    mtime: Number.isFinite(mtime) ? mtime : undefined
  }
}

function createBook(input: { name: string; content: string; path?: string; size?: number; mtime?: number }): Book {
  const now = Date.now()
  const stable = input.path ?? `${input.name}:${input.content.length}:${now}`

  return {
    id: `book:${btoa(unescape(encodeURIComponent(stable))).slice(0, 28)}:${now.toString(36)}`,
    title: normalizeTitle(input.name),
    sourceName: input.name,
    path: input.path,
    content: tidyContent(input.content),
    createdAt: now,
    updatedAt: now,
    progressIndex: 0,
    size: input.size ?? input.content.length,
    mtime: input.mtime
  }
}

function tidyContent(content: string) {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function upsertBook(book: Book) {
  const existingIndex = books.value.findIndex((item) => item.path && book.path && item.path === book.path)
  if (existingIndex >= 0) {
    const existing = books.value[existingIndex]
    books.value[existingIndex] = {
      ...book,
      id: existing.id,
      createdAt: existing.createdAt,
      progressIndex: Math.min(existing.progressIndex, getApproxMaxPageStart(book.content.length))
    }
  } else {
    books.value.unshift(book)
  }

  activeBookId.value = existingIndex >= 0 ? books.value[existingIndex].id : book.id
  activePanel.value = 'library'
  isReaderHidden.value = false
  persistLibrary()
  storage.set(LAST_BOOK_KEY, activeBookId.value)
}

function importFromZToolsPath(filePath: string) {
  importError.value = ''

  try {
    const file = window.services?.readTextFile(filePath)
    if (!file) throw new Error('ZTools preload 未就绪')
    upsertBook(createBook(file))
  } catch (error) {
    importError.value = error instanceof Error ? error.message : '读取文件失败'
  }
}

function importBrowserFile(file: File) {
  importError.value = ''
  const reader = new FileReader()

  reader.onload = () => {
    if (!(reader.result instanceof ArrayBuffer)) {
      importError.value = '读取文件失败'
      return
    }

    const decoded = decodeTextBytes(reader.result)

    upsertBook(
      createBook({
        name: file.name,
        content: decoded.content,
        size: file.size,
        mtime: file.lastModified
      })
    )
  }

  reader.onerror = () => {
    importError.value = '读取文件失败'
  }

  reader.readAsArrayBuffer(file)
}

function openImportDialog() {
  importError.value = ''

  if (window.ztools?.showOpenDialog) {
    const picker = window.ztools.showOpenDialog({
      title: '选择小说文件',
      buttonLabel: '导入',
      filters: [{ name: 'Text', extensions: ['txt', 'md'] }],
      properties: ['openFile']
    })

    if (picker?.[0]) importFromZToolsPath(picker[0])
    return
  }

  fileInputRef.value?.click()
}

function handleBrowserFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) importBrowserFile(file)
  input.value = ''
}

function isFileDrag(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

function setDropEffect(event: DragEvent) {
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function isDragPointInside(event: DragEvent) {
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return false

  const rect = target.getBoundingClientRect()
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
}

function handleDragEnter(event: DragEvent) {
  if (!isFileDrag(event)) return

  dragDepth += 1
  setDropEffect(event)
  isDragging.value = true
}

function handleDragOver(event: DragEvent) {
  if (!isFileDrag(event)) return

  setDropEffect(event)
  isDragging.value = true
}

function handleDragLeave(event: DragEvent) {
  if (!isDragging.value) return

  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth > 0 && isDragPointInside(event)) return

  dragDepth = 0
  isDragging.value = false
}

function handleDrop(event: DragEvent) {
  dragDepth = 0
  isDragging.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) importBrowserFile(file)
}

function selectBook(bookId: string) {
  activeBookId.value = bookId
  activePanel.value = 'library'
  isReaderHidden.value = false
  storage.set(LAST_BOOK_KEY, bookId)
}

function updateProgressIndex(index: number) {
  const book = activeBook.value
  if (!book) return

  book.progressIndex = clampNumber(index, 0, activeMaxPageStart.value)
  book.updatedAt = Date.now()
  persistLibrary()
}

function nextPage() {
  const book = activeBook.value
  if (!book) return
  if (currentPageSlice.value.endIndex >= book.content.length) return
  updateProgressIndex(currentPageSlice.value.endIndex)
}

function prevPage() {
  if (!activeBook.value) return
  updateProgressIndex(getPreviousPageStart(currentIndex.value, activePageStarts.value))
}

function jumpToIndex(index: number) {
  updateProgressIndex(index)
  activePanel.value = 'library'
  isReaderHidden.value = false
}

function jumpToSearchMatch(index: number) {
  const match = searchMatches.value[index]
  if (typeof match !== 'number') return
  searchCursor.value = index
  jumpToIndex(match)
}

function jumpToNextSearchMatch() {
  if (!searchMatches.value.length) return
  const next = (searchCursor.value + 1) % searchMatches.value.length
  jumpToSearchMatch(next)
}

function toggleAutoPaging() {
  if (!activeBook.value) return
  isAutoPaging.value = !isAutoPaging.value
}

function focusFishKeyboard() {
  isFishKeyboardActive.value = true
  if (!fishWindow || fishWindow.isDestroyed?.()) return

  fishWindow.setSkipTaskbar?.(true)
  fishWindow.setFocusable?.(true)
  fishWindow.focus?.()
  fishWindow.setSkipTaskbar?.(true)
  fishWindow.setAlwaysOnTop?.(true)
  fishWindow.moveTop?.()
}

function blurFishKeyboard() {
  isFishKeyboardActive.value = false
  if (!fishWindow || fishWindow.isDestroyed?.()) return

  fishWindow.blur?.()
  fishWindow.setSkipTaskbar?.(true)
  fishWindow.setFocusable?.(false)
}

function canUsePageKeyboard() {
  if (!activeBook.value) return false
  if (typeof window.ztools?.createBrowserWindow === 'function') return isFishKeyboardActive.value
  return true
}

function toggleHidden() {
  isReaderHidden.value = !isReaderHidden.value
  if (isReaderHidden.value) blurFishKeyboard()
}

function hideFishWindow() {
  isReaderHidden.value = true
  blurFishKeyboard()
}

function toggleStealth() {
  settings.stealth = !settings.stealth
  persistSettings()
}

function resetFishBackgrounds() {
  Object.assign(settings.fishBackgrounds, DEFAULT_FISH_BACKGROUNDS)
}

function closePlugin() {
  isReaderHidden.value = true
  try {
    window.ztools?.outPlugin?.()
  } catch (error) {
    // Browser preview keeps the concealed reader visible.
  }
}

function removeBook(bookId: string) {
  books.value = books.value.filter((book) => book.id !== bookId)
  if (activeBookId.value === bookId) {
    activeBookId.value = books.value[0]?.id ?? ''
    storage.set(LAST_BOOK_KEY, activeBookId.value)
  }
  contextMenu.show = false
  persistLibrary()
}

function revealPanel(panel: Panel) {
  activePanel.value = activePanel.value === panel ? 'library' : panel
}

function syncPluginWindowSize() {
  window.ztools?.setExpendHeight?.(680)
  window.ztools?.resizeWindow?.(920, 680)
}

function getWorkArea() {
  const display = window.ztools?.getPrimaryDisplay?.()
  return display?.workArea ?? { x: 0, y: 0, width: window.screen.availWidth, height: window.screen.availHeight }
}

function clampNumber(value: number, min: number, max: number) {
  const safeMin = Number.isFinite(min) ? min : 0
  const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : safeMin
  const safeValue = Number.isFinite(value) ? value : safeMin

  return Math.min(safeMax, Math.max(safeMin, Math.round(safeValue)))
}

function getFishSizeLimits() {
  const area = getWorkArea()

  return {
    minWidth: FISH_MIN_WIDTH,
    maxWidth: Math.max(FISH_MIN_WIDTH, Math.min(area.width, FISH_MAX_WIDTH)),
    minHeight: FISH_MIN_HEIGHT,
    maxHeight: Math.max(FISH_MIN_HEIGHT, Math.min(area.height, FISH_MAX_HEIGHT))
  }
}

function clampFishSize(width: number, height: number) {
  const limits = getFishSizeLimits()

  return {
    width: clampNumber(width, limits.minWidth, limits.maxWidth),
    height: clampNumber(height, limits.minHeight, limits.maxHeight)
  }
}

function hasStoredFishPosition() {
  return Number.isFinite(settings.fishX) && Number.isFinite(settings.fishY)
}

function getStoredFishAnchor() {
  if (!hasStoredFishPosition()) return null
  return { x: settings.fishX as number, y: settings.fishY as number }
}

function getFishWindowBounds() {
  return getAnchoredFishWindowBoundsForSize(settings.fishWidth, settings.fishHeight)
}

function getInitialFishWindowBoundsForSize(width: number, height: number) {
  const area = getWorkArea()
  const size = clampFishSize(width, height)

  return {
    ...size,
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: Math.round(area.y + area.height - size.height)
  }
}

function getAnchoredFishWindowBoundsForSize(width: number, height: number) {
  const area = getWorkArea()
  const size = clampFishSize(width, height)
  const fallback = fishWindowAnchor ?? getStoredFishAnchor() ?? getInitialFishWindowBoundsForSize(size.width, size.height)
  const maxX = area.x + Math.max(0, area.width - size.width)
  const maxY = area.y + Math.max(0, area.height - size.height)

  return {
    ...size,
    x: clampNumber(fallback.x, area.x, maxX),
    y: clampNumber(fallback.y, area.y, maxY)
  }
}

function getMovedFishWindowBounds(x: number, y: number) {
  const area = getWorkArea()
  const size = clampFishSize(settings.fishWidth, settings.fishHeight)
  const maxX = area.x + Math.max(0, area.width - size.width)
  const maxY = area.y + Math.max(0, area.height - size.height)

  return {
    ...size,
    x: clampNumber(x, area.x, maxX),
    y: clampNumber(y, area.y, maxY)
  }
}

function getFishPayload(bounds = getFishWindowBounds()) {
  return {
    visible: Boolean(activeBook.value) && !isReaderHidden.value,
    title: activeBookLabel.value,
    chapter: currentChapter.value?.title ?? '',
    progress: progressLabel.value,
    currentPage: currentPage.value + 1,
    pageCount: pageCount.value,
    lines: fishLines.value,
    bounds,
    resizeLimits: getFishSizeLimits(),
    settings: {
      fishSkin: settings.fishSkin,
      fishBackgrounds: settings.fishBackgrounds,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      fishWidth: settings.fishWidth,
      fishHeight: settings.fishHeight,
      fishX: settings.fishX,
      fishY: settings.fishY,
      letterSpacing: settings.letterSpacing,
      opacity: settings.opacity,
      prevPageKey: settings.prevPageKey,
      nextPageKey: settings.nextPageKey,
      showFishPrefix: settings.showFishPrefix,
      showFishMeta: settings.showFishMeta,
      hideOnMouseLeave: settings.hideOnMouseLeave,
      wheelTurnPage: settings.wheelTurnPage,
      stealth: settings.stealth
    }
  }
}

function applyFishWindowBounds(bounds: FishBounds) {
  if (!fishWindow || fishWindow.isDestroyed?.()) return

  fishWindowAnchor = { x: bounds.x, y: bounds.y }
  fishWindow.setContentBounds?.(bounds)
  fishWindow.setContentSize?.(bounds.width, bounds.height)
  fishWindow.setSize?.(bounds.width, bounds.height)
  fishWindow.setPosition?.(bounds.x, bounds.y)
  fishWindow.setAlwaysOnTop?.(true)
  fishWindow.setSkipTaskbar?.(true)
  fishWindow.moveTop?.()
}

function positionFishWindow() {
  applyFishWindowBounds(getFishWindowBounds())
}

function previewFishWindowSize(width: number, height: number) {
  if (!fishWindow || fishWindow.isDestroyed?.() || !Number.isFinite(width) || !Number.isFinite(height)) return

  applyFishWindowBounds(getAnchoredFishWindowBoundsForSize(width, height))
}

function previewFishWindowPosition(x: number, y: number) {
  if (!fishWindow || fishWindow.isDestroyed?.() || !Number.isFinite(x) || !Number.isFinite(y)) return

  applyFishWindowBounds(getMovedFishWindowBounds(x, y))
}

function pushFishState() {
  if (!fishWindow || fishWindow.isDestroyed?.()) return

  const bounds = getFishWindowBounds()
  const payload = getFishPayload(bounds)

  if (payload.visible) {
    applyFishWindowBounds(bounds)
    fishWindow.show?.()
  } else {
    fishWindow.hide?.()
  }

  const sync = fishWindow.webContents?.executeJavaScript?.(`window.deepreadFishSetState?.(${JSON.stringify(payload)})`)
  void sync?.catch((error) => {
    console.warn('[DeepRead] fish window sync failed', error)
  })
}

function ensureFishWindow() {
  if (!window.ztools?.createBrowserWindow || !activeBook.value) return
  if (fishWindow && !fishWindow.isDestroyed?.()) {
    pushFishState()
    return
  }

  const bounds = getFishWindowBounds()
  fishWindowAnchor = { x: bounds.x, y: bounds.y }
  fishWindow = window.ztools.createBrowserWindow(
    'fish.html',
    {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      show: false,
      title: 'DeepRead Fish',
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      skipTaskBar: true,
      showInTaskbar: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      focusable: true,
      acceptFirstMouse: true,
      alwayOnTop: true,
      alwaysOnTop: true,
      webPreferences: {
        devTools: false,
        zoomFactor: 1,
        nodeIntegration: false,
        contextIsolation: false
      }
    },
    () => pushFishState()
  )

  pushFishState()
}

function showFishWindow() {
  isReaderHidden.value = false
  ensureFishWindow()
  nextTick(pushFishState)
}

function resizeFishWindow(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return

  const size = clampFishSize(width, height)
  settings.fishWidth = size.width
  settings.fishHeight = size.height
  positionFishWindow()
  nextTick(pushFishState)
}

function moveFishWindow(x: number, y: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return

  const bounds = getMovedFishWindowBounds(x, y)
  settings.fishX = bounds.x
  settings.fishY = bounds.y
  applyFishWindowBounds(bounds)
  nextTick(pushFishState)
}

function startPageKeyCapture(action: PageKeyAction) {
  keyBindingCapture.value = action
}

function cancelPageKeyCapture(action: PageKeyAction) {
  if (keyBindingCapture.value === action) keyBindingCapture.value = null
}

function setPageKeyBinding(action: PageKeyAction, event: KeyboardEvent) {
  const binding = getKeyboardEventBinding(event)
  if (!binding) return

  const previousPrevKey = settings.prevPageKey
  const previousNextKey = settings.nextPageKey

  if (action === 'prev') {
    settings.prevPageKey = binding
    if (previousNextKey === binding) settings.nextPageKey = previousPrevKey
  } else {
    settings.nextPageKey = binding
    if (previousPrevKey === binding) settings.prevPageKey = previousNextKey
  }

  keyBindingCapture.value = null
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.blur()
}

function handlePageKeyButtonKeydown(action: PageKeyAction, event: KeyboardEvent) {
  if (keyBindingCapture.value !== action) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      startPageKeyCapture(action)
    }
    return
  }

  event.preventDefault()
  event.stopPropagation()
  setPageKeyBinding(action, event)
}

function handleWheel(event: WheelEvent) {
  if (!settings.wheelTurnPage || wheelLock || !activeBook.value || isReaderHidden.value) return
  if (Math.abs(event.deltaY) < 18) return

  wheelLock = true
  event.preventDefault()
  if (event.deltaY > 0) nextPage()
  else prevPage()

  window.setTimeout(() => {
    wheelLock = false
  }, 260)
}

function handleKeydown(event: KeyboardEvent) {
  if (keyBindingCapture.value) return
  if (isKeyboardShortcutTarget(event.target)) return

  const binding = getKeyboardEventBinding(event)
  const prevPageKey = normalizeKeyBinding(settings.prevPageKey, defaultSettings.prevPageKey)
  const nextPageKey = normalizeKeyBinding(settings.nextPageKey, defaultSettings.nextPageKey)

  if (canUsePageKeyboard() && binding && binding === nextPageKey) {
    event.preventDefault()
    nextPage()
    return
  }

  if (canUsePageKeyboard() && binding && binding === prevPageKey) {
    event.preventDefault()
    prevPage()
    return
  }

  if (hasCommandModifier(event)) return

  const key = normalizeKeyboardKey(event.key)
  if (key === 'H' || key === 'Escape') {
    event.preventDefault()
    toggleHidden()
  } else if (key === 'A') {
    event.preventDefault()
    toggleAutoPaging()
  } else if (key === 'S') {
    event.preventDefault()
    toggleStealth()
  }
}

function openContextMenu(book: Book, event: MouseEvent) {
  contextMenu.show = true
  contextMenu.bookId = book.id
  contextMenu.x = Math.min(event.clientX, window.innerWidth - 190)
  contextMenu.y = Math.min(event.clientY, window.innerHeight - 210)
}

function closeContextMenu() {
  contextMenu.show = false
}

function handleContextAction(action: 'read' | 'chapters' | 'search' | 'remove') {
  const bookId = contextMenu.bookId
  contextMenu.show = false

  if (action === 'remove') {
    removeBook(bookId)
    return
  }

  selectBook(bookId)
  if (action === 'chapters') activePanel.value = 'chapters'
  if (action === 'search') activePanel.value = 'search'
}

function handlePluginCommand(action: ZToolsFeatureEnterAction) {
  if (action.code === 'deepread-import' && action.type === 'files') {
    const filePath = (action.payload as ZToolsFilePayload[] | undefined)?.[0]?.path
    if (filePath) importFromZToolsPath(filePath)
    return
  }

  if (action.code === 'deepread-prev-page') prevPage()
  else if (action.code === 'deepread-next-page') nextPage()
  else if (action.code === 'deepread-toggle-show') toggleHidden()
  else if (action.code === 'deepread-close') closePlugin()
  else if (action.code === 'deepread-toggle-auto') toggleAutoPaging()
  else if (action.code === 'deepread-toggle-stealth') toggleStealth()
  else {
    nextTick(() => {
      if (activeBook.value) ensureFishWindow()
    })
  }
}

function handleFishCommand(command: FishCommand) {
  if (typeof command !== 'string') {
    if (command?.type === 'resize-preview' && typeof command.width === 'number' && typeof command.height === 'number') {
      previewFishWindowSize(command.width, command.height)
    }
    if (command?.type === 'resize' && typeof command.width === 'number' && typeof command.height === 'number') {
      resizeFishWindow(command.width, command.height)
    }
    if (command?.type === 'move-preview' && typeof command.x === 'number' && typeof command.y === 'number') {
      previewFishWindowPosition(command.x, command.y)
    }
    if (command?.type === 'move' && typeof command.x === 'number' && typeof command.y === 'number') {
      moveFishWindow(command.x, command.y)
    }
    return
  }

  if (command === 'prev') prevPage()
  else if (command === 'next') nextPage()
  else if (command === 'focus') focusFishKeyboard()
  else if (command === 'blur') blurFishKeyboard()
  else if (command === 'hide') hideFishWindow()
  else if (command === 'close') closePlugin()
  else if (command === 'auto') toggleAutoPaging()
}

watch(
  settings,
  () => persistSettings(),
  { deep: true }
)

watch(
  () => [isAutoPaging.value, settings.autoSeconds, activeBookId.value, isReaderHidden.value],
  () => {
    window.clearInterval(autoTimer)
    if (!isAutoPaging.value || !activeBook.value || isReaderHidden.value) return

    autoTimer = window.setInterval(() => {
      if (currentPage.value >= pageCount.value - 1) {
        isAutoPaging.value = false
      } else {
        nextPage()
      }
    }, Math.max(3, settings.autoSeconds) * 1000)
  },
  { immediate: true }
)

watch(
  () => activeBookId.value,
  (id) => storage.set(LAST_BOOK_KEY, id)
)

watch(
  () => [
    activeBookId.value,
    currentIndex.value,
    currentPage.value,
    isReaderHidden.value,
    settings.fishSkin,
    settings.fishBackgrounds.statusbar,
    settings.fishBackgrounds.code,
    settings.fishBackgrounds.terminal,
    settings.fontSize,
    settings.lineHeight,
    settings.fishWidth,
    settings.fishHeight,
    settings.fishX,
    settings.fishY,
    settings.letterSpacing,
    settings.opacity,
    settings.prevPageKey,
    settings.nextPageKey,
    settings.showFishPrefix,
    settings.showFishMeta,
    settings.hideOnMouseLeave,
    settings.wheelTurnPage,
    settings.stealth
  ],
  () => {
    nextTick(() => {
      if (activeBook.value) {
        ensureFishWindow()
      } else {
        pushFishState()
      }
    })
  },
  { immediate: true }
)

onMounted(() => {
  loadState()
  window.addEventListener('keydown', handleKeydown, true)
  window.addEventListener('click', closeContextMenu)

  window.ztools?.onPluginEnter?.((action) => {
    handlePluginCommand(action)
    nextTick(() => {
      syncPluginWindowSize()
    })
  })

  window.ztools?.onPluginOut?.((processExit) => {
    if (processExit) fishWindow?.close?.()
  })

  nextTick(syncPluginWindowSize)
  offFishCommand = window.services?.onFishCommand?.(handleFishCommand)
  nextTick(() => {
    if (activeBook.value) ensureFishWindow()
  })
})

onBeforeUnmount(() => {
  window.clearInterval(autoTimer)
  window.removeEventListener('keydown', handleKeydown, true)
  window.removeEventListener('click', closeContextMenu)
  offFishCommand?.()
  fishWindow?.close?.()
})
</script>

<template>
  <main
    class="app-shell"
    :class="[`theme-${settings.theme}`, { stealth: settings.stealth, concealed: isReaderHidden }]"
    :style="readerStyle"
    @dragenter.prevent="handleDragEnter"
    @dragover.prevent="handleDragOver"
    @dragleave.prevent="handleDragLeave"
    @drop.prevent="handleDrop"
  >
    <input ref="fileInputRef" class="hidden-input" type="file" accept=".txt,.md,text/plain,text/markdown" @change="handleBrowserFile" />

    <div v-if="isDragging" class="drop-layer">
      <Upload :size="34" />
      <span>释放文件</span>
    </div>

    <section class="topbar">
      <div class="brand">
        <span class="brand-mark"><BookOpen :size="18" /></span>
        <div>
          <strong>{{ shellTitle }}</strong>
          <small>{{ shellSubtitle }}</small>
        </div>
      </div>

      <div class="command-strip">
        <button class="icon-button" title="书架" :class="{ active: activePanel === 'library' }" @click="revealPanel('library')">
          <Library :size="18" />
        </button>
        <button class="icon-button" title="目录" :class="{ active: activePanel === 'chapters' }" :disabled="!activeBook" @click="revealPanel('chapters')">
          <List :size="18" />
        </button>
        <button class="icon-button" title="搜索" :class="{ active: activePanel === 'search' }" :disabled="!activeBook" @click="revealPanel('search')">
          <Search :size="18" />
        </button>
        <button class="icon-button" title="设置" :class="{ active: activePanel === 'settings' }" @click="revealPanel('settings')">
          <Settings :size="18" />
        </button>
        <button class="icon-button" title="导入" @click="openImportDialog">
          <Upload :size="18" />
        </button>
        <button class="icon-button" :title="isAutoPaging ? '暂停自动翻页' : '自动翻页'" :disabled="!activeBook" @click="toggleAutoPaging">
          <Pause v-if="isAutoPaging" :size="18" />
          <Play v-else :size="18" />
        </button>
        <button class="icon-button" :title="isReaderHidden ? '显示' : '隐藏'" @click="toggleHidden">
          <Eye v-if="isReaderHidden" :size="18" />
          <EyeOff v-else :size="18" />
        </button>
      </div>
    </section>

    <section class="workspace">
      <aside class="side-panel">
        <template v-if="activePanel === 'library'">
          <div class="panel-head">
            <span><Library :size="16" /> 书架</span>
            <button class="text-button" @click="openImportDialog"><FolderOpen :size="15" /> 导入</button>
          </div>

          <p v-if="importError" class="error-line">{{ importError }}</p>

          <div v-if="!books.length" class="empty-state">
            <div class="empty-decor">
              <div class="empty-glow"></div>
              <BookOpen :size="48" class="empty-icon" />
            </div>
            <strong>书架空空如也</strong>
            <p>“书籍是人类进步的阶梯，也是绝佳的摸鱼道具。”</p>
            <button class="primary-button import-glow" @click="openImportDialog"><Upload :size="16" /> 导入精品小说</button>
          </div>

          <div v-else class="book-list">
            <article
              v-for="book in sortedBooks"
              :key="book.id"
              class="book-card"
              :class="[{ active: book.id === activeBookId }, getBookColorClass(book.title)]"
              @click="selectBook(book.id)"
              @contextmenu.prevent="openContextMenu(book, $event)"
            >
              <div class="book-cover-container">
                <div class="book-pages-stack"></div>
                <div class="book-cover">
                  <div class="book-spine"></div>
                  <div class="book-cover-glare"></div>
                  <div class="book-cover-title">
                    <span class="book-cover-text-vertical">{{ book.title.slice(0, 4) }}</span>
                  </div>
                  <div class="book-ribbon" :style="{ height: `${Math.max(15, Math.min(45, getBookProgressPercent(book)))}px` }"></div>
                </div>
              </div>
              <div class="book-meta">
                <strong class="book-title-text">{{ book.title }}</strong>
                <small class="book-info-text">{{ getBookProgressPercent(book) }}% · {{ Math.ceil(book.content.length / 10000) }} 万字</small>
                <div class="progress-track">
                  <span :style="{ width: `${getBookProgressPercent(book)}%` }"></span>
                </div>
              </div>
              <button class="mini-icon card-more-btn" title="更多" @click.stop="openContextMenu(book, $event)">
  <MoreVertical :size="16" />
              </button>
            </article>
          </div>
        </template>

        <template v-if="activePanel === 'chapters'">
          <div class="panel-head">
            <span><List :size="16" /> 目录</span>
            <button class="icon-button small" @click="activePanel = 'library'"><X :size="16" /></button>
          </div>
          <div class="chapter-list">
            <button
              v-for="chapter in chapters"
              :key="`${chapter.index}-${chapter.title}`"
              :class="{ active: currentChapter?.index === chapter.index }"
              @click="jumpToIndex(chapter.index)"
            >
              <span>{{ chapter.title }}</span>
              <small>{{ Math.floor(chapter.index / Math.max(1, activeBook?.content.length ?? 1) * 100) }}%</small>
            </button>
          </div>
        </template>

        <template v-if="activePanel === 'search'">
          <div class="panel-head">
            <span><Search :size="16" /> 搜索</span>
            <button class="icon-button small" @click="activePanel = 'library'"><X :size="16" /></button>
          </div>
          <div class="search-box">
            <input v-model.trim="searchText" placeholder="关键字" @keydown.enter="jumpToNextSearchMatch" />
            <button class="primary-button" :disabled="!searchMatches.length" @click="jumpToNextSearchMatch">跳转</button>
          </div>
          <div class="search-list">
            <button v-for="(match, index) in searchMatches" :key="match" @click="jumpToSearchMatch(index)">
              <strong>{{ index + 1 }}</strong>
              <span>{{ activeBook?.content.slice(Math.max(0, match - 16), match + searchText.length + 38) }}</span>
            </button>
          </div>
        </template>

        <template v-if="activePanel === 'settings'">
          <div class="panel-head">
            <span><SlidersHorizontal :size="16" /> 设置</span>
            <button class="icon-button small" @click="activePanel = 'library'"><X :size="16" /></button>
          </div>

          <div class="settings-stack">
            <section class="settings-section">
              <div class="settings-section-head">
                <strong>外观</strong>
              </div>
              <div class="segmented-control four">
                <button :class="{ active: settings.theme === 'work' }" @click="settings.theme = 'work'">工作台</button>
                <button :class="{ active: settings.theme === 'paper' }" @click="settings.theme = 'paper'">纸张</button>
                <button :class="{ active: settings.theme === 'night' }" @click="settings.theme = 'night'">夜间</button>
                <button :class="{ active: settings.theme === 'transparent' }" @click="settings.theme = 'transparent'">透明</button>
              </div>
              <label class="switch-row">
                <span>低调外观（伪装标题）</span>
                <input v-model="settings.stealth" type="checkbox" />
                <i aria-hidden="true"></i>
              </label>
            </section>

            <section class="settings-section">
              <div class="settings-section-head">
                <strong>阅读</strong>
              </div>
              <label class="range-row">
                <span>字号</span>
                <input v-model.number="settings.fontSize" type="range" min="10" max="20" />
                <output>{{ settings.fontSize }}</output>
              </label>
              <label class="range-row">
                <span>行距</span>
                <input v-model.number="settings.lineHeight" type="range" min="1.05" max="1.8" step="0.05" />
                <output>{{ settings.lineHeight.toFixed(2) }}</output>
              </label>
            </section>

            <section class="settings-section">
              <div class="settings-section-head">
                <strong>底栏</strong>
                <button class="reset-button" type="button" @click="resetFishBackgrounds">
                  <RotateCcw :size="13" /> 重置
                </button>
              </div>
              <div class="segmented-control">
                <button :class="{ active: settings.fishSkin === 'code' }" @click="settings.fishSkin = 'code'">代码</button>
                <button :class="{ active: settings.fishSkin === 'statusbar' }" @click="settings.fishSkin = 'statusbar'">状态栏</button>
                <button :class="{ active: settings.fishSkin === 'terminal' }" @click="settings.fishSkin = 'terminal'">终端</button>
              </div>
              <label class="color-row">
                <span>状态栏背景</span>
                <input v-model="settings.fishBackgrounds.statusbar" type="color" />
                <output>{{ settings.fishBackgrounds.statusbar }}</output>
              </label>
              <label class="color-row">
                <span>代码背景</span>
                <input v-model="settings.fishBackgrounds.code" type="color" />
                <output>{{ settings.fishBackgrounds.code }}</output>
              </label>
              <label class="color-row">
                <span>终端背景</span>
                <input v-model="settings.fishBackgrounds.terminal" type="color" />
                <output>{{ settings.fishBackgrounds.terminal }}</output>
              </label>
              <label class="range-row">
                <span>宽度</span>
                <input v-model.number="settings.fishWidth" type="range" min="280" max="1180" step="10" />
                <output>{{ settings.fishWidth }}</output>
              </label>
              <label class="range-row">
                <span>高度</span>
                <input v-model.number="settings.fishHeight" type="range" min="22" max="160" step="2" />
                <output>{{ settings.fishHeight }}</output>
              </label>
              <label class="range-row">
                <span>字距</span>
                <input v-model.number="settings.letterSpacing" type="range" min="0" max="3" step="0.1" />
                <output>{{ settings.letterSpacing.toFixed(1) }}</output>
              </label>
              <label class="range-row">
                <span>透明度</span>
                <input v-model.number="settings.opacity" type="range" min="0" max="100" />
                <output>{{ settings.opacity }}%</output>
              </label>
              <label class="switch-row">
                <span>显示左侧标识</span>
                <input v-model="settings.showFishPrefix" type="checkbox" />
                <i aria-hidden="true"></i>
              </label>
              <label class="switch-row">
                <span>显示进度角标</span>
                <input v-model="settings.showFishMeta" type="checkbox" />
                <i aria-hidden="true"></i>
              </label>
            </section>

            <section class="settings-section">
              <div class="settings-section-head">
                <strong>行为</strong>
              </div>
              <label class="range-row">
                <span>自动翻页</span>
                <input v-model.number="settings.autoSeconds" type="range" min="3" max="60" />
                <output>{{ settings.autoSeconds }}s</output>
              </label>
              <label class="keybind-row">
                <span>上一页</span>
                <button
                  class="keybind-button"
                  :class="{ capturing: keyBindingCapture === 'prev' }"
                  type="button"
                  @click="startPageKeyCapture('prev')"
                  @blur="cancelPageKeyCapture('prev')"
                  @keydown="handlePageKeyButtonKeydown('prev', $event)"
                >
                  {{ keyBindingCapture === 'prev' ? '按键中' : getKeyBindingLabel(settings.prevPageKey) }}
                </button>
              </label>
              <label class="keybind-row">
                <span>下一页</span>
                <button
                  class="keybind-button"
                  :class="{ capturing: keyBindingCapture === 'next' }"
                  type="button"
                  @click="startPageKeyCapture('next')"
                  @blur="cancelPageKeyCapture('next')"
                  @keydown="handlePageKeyButtonKeydown('next', $event)"
                >
                  {{ keyBindingCapture === 'next' ? '按键中' : getKeyBindingLabel(settings.nextPageKey) }}
                </button>
              </label>
              <label class="switch-row">
                <span>鼠标移出隐藏</span>
                <input v-model="settings.hideOnMouseLeave" type="checkbox" />
                <i aria-hidden="true"></i>
              </label>
              <label class="switch-row">
                <span>滚轮翻页</span>
                <input v-model="settings.wheelTurnPage" type="checkbox" />
                <i aria-hidden="true"></i>
              </label>
            </section>
          </div>
        </template>
      </aside>
    </section>

    <div v-if="contextMenu.show" class="context-menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }">
      <button @click="handleContextAction('read')"><BookOpen :size="15" /> 阅读</button>
      <button @click="handleContextAction('chapters')"><List :size="15" /> 章节跳转</button>
      <button @click="handleContextAction('search')"><Search :size="15" /> 搜索跳转</button>
      <button class="danger" @click="handleContextAction('remove')"><Trash2 :size="15" /> 移除</button>
    </div>
  </main>
</template>
