const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const NUMBERS = '0123456789'
const SYMBOLS = '!@#$%^&*()-_=+[]{}:,.?'
const AMBIGUOUS = new Set('Il1O0o|`\'"')
const PHRASE_WORDS = [
  'amber', 'anchor', 'apple', 'april', 'arch', 'arrow', 'atlas', 'autumn',
  'bamboo', 'beacon', 'birch', 'bird', 'bloom', 'blue', 'bold', 'brook',
  'cabin', 'cactus', 'canyon', 'cedar', 'charm', 'cherry', 'cloud', 'cobalt',
  'comet', 'coral', 'crane', 'crisp', 'dawn', 'delta', 'drift', 'dune',
  'eagle', 'earth', 'echo', 'ember', 'falcon', 'fern', 'field', 'flame',
  'forest', 'frost', 'garden', 'glade', 'glass', 'globe', 'gold', 'granite',
  'harbor', 'hazel', 'heron', 'hill', 'honey', 'indigo', 'island', 'ivy',
  'jade', 'jazz', 'juniper', 'lake', 'lark', 'leaf', 'lemon', 'light',
  'lilac', 'linden', 'lotus', 'lunar', 'maple', 'marble', 'meadow', 'mint',
  'mist', 'moon', 'moss', 'navy', 'north', 'nova', 'oak', 'ocean',
  'olive', 'onyx', 'orbit', 'orchid', 'otter', 'pearl', 'pine', 'plum',
  'pond', 'prism', 'quartz', 'rain', 'raven', 'reef', 'river', 'robin',
  'rose', 'sage', 'sand', 'scarlet', 'silver', 'sky', 'solar', 'south',
  'spark', 'spring', 'star', 'stone', 'storm', 'sun', 'swift', 'teal',
  'thistle', 'tiger', 'trail', 'tulip', 'valley', 'velvet', 'violet', 'wave',
  'west', 'willow', 'wind', 'winter', 'wren', 'yarrow', 'zebra', 'zenith',
] as const

export interface RandomPasswordOptions {
  length: number
  lowercase: boolean
  uppercase: boolean
  numbers: boolean
  symbols: boolean
  avoidAmbiguous: boolean
}

export interface PassphraseOptions {
  wordCount: number
  separator: string
  capitalize: boolean
  includeNumber: boolean
}

export function generateRandomPassword(options: RandomPasswordOptions): string {
  const characterSets = [
    options.lowercase ? LOWER : '',
    options.uppercase ? UPPER : '',
    options.numbers ? NUMBERS : '',
    options.symbols ? SYMBOLS : '',
  ].filter(Boolean).map((characters) => options.avoidAmbiguous
    ? [...characters].filter((character) => !AMBIGUOUS.has(character)).join('')
    : characters)
  if (characterSets.length === 0) throw new Error('Choose at least one character type')
  const length = Math.max(characterSets.length, boundedInteger(options.length, 12, 128, 24))
  const allCharacters = characterSets.join('')
  const password = characterSets.map((characters) => randomCharacter(characters))
  while (password.length < length) password.push(randomCharacter(allCharacters))
  shuffle(password)
  return password.join('')
}

export function generatePassphrase(options: PassphraseOptions): string {
  const wordCount = boundedInteger(options.wordCount, 4, 12, 8)
  const words = Array.from({ length: wordCount }, () => {
    const word = PHRASE_WORDS[secureRandomInt(PHRASE_WORDS.length)]!
    return options.capitalize ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word
  })
  if (options.includeNumber) words.push(String(secureRandomInt(10_000)).padStart(4, '0'))
  return words.join(options.separator)
}

function randomCharacter(characters: string): string {
  return characters[secureRandomInt(characters.length)]!
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function secureRandomInt(maximum: number): number {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid random range')
  const limit = Math.floor(0x1_0000_0000 / maximum) * maximum
  const sample = new Uint32Array(1)
  do crypto.getRandomValues(sample)
  while (sample[0]! >= limit)
  return sample[0]! % maximum
}

function shuffle(values: string[]): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = secureRandomInt(index + 1)
    ;[values[index], values[swapIndex]] = [values[swapIndex]!, values[index]!]
  }
}
