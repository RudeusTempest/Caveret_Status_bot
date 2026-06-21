import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_CONFIG_PATH = resolve('moderation-rules.json')

const HEBREW_FINALS = new Set(['ך', 'ם', 'ן', 'ף', 'ץ'])
const PUNCTUATION = new Set([
  '.', ',', '!', '?', ':', ';',
  '۔', '،', '؛', '؟',
  '。', '，', '！', '？',
  '…'
])

const DASHES = new Set(['-', '_', '‐', '‑', '‒', '–', '—', '―'])
const QUOTES = new Set(['"', "'", '`', '´', '“', '”', '‘', '’'])

function parseModerationConfig(rawConfig) {
  if (!rawConfig) {
    return undefined
  }

  return JSON.parse(rawConfig)
}

function loadModerationConfig() {
  const envConfig = parseModerationConfig(process.env.COMMENT_MODERATION_CONFIG_JSON)

  if (envConfig) {
    return envConfig
  }

  const configPath = process.env.COMMENT_MODERATION_CONFIG_FILE
    ? resolve(process.env.COMMENT_MODERATION_CONFIG_FILE)
    : DEFAULT_CONFIG_PATH

  return JSON.parse(readFileSync(configPath, 'utf8'))
}

function normalizePunctuation(char) {
  if (PUNCTUATION.has(char)) {
    return ' '
  }

  if (DASHES.has(char) || QUOTES.has(char)) {
    return ' '
  }

  return char
}

function isWhitespace(char) {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t'
}

function isHebrewFinal(char) {
  return HEBREW_FINALS.has(char)
}

export function normalizeCommentText(text) {
  if (typeof text !== 'string') {
    return ''
  }

  let normalized = ''
  let previousWasSpace = true

  for (const rawChar of text.trim()) {
    const lowerChar = rawChar.toLowerCase()
    const char = normalizePunctuation(lowerChar)

    if (isWhitespace(char)) {
      if (!previousWasSpace) {
        normalized += ' '
        previousWasSpace = true
      }
      continue
    }

    normalized += char
    previousWasSpace = false
  }

  return normalized.trim()
}

export function collapseRepeatedCharacters(text) {
  let collapsed = ''
  let previousChar = ''

  for (const char of text) {
    if (char === previousChar && !isHebrewFinal(char)) {
      continue
    }

    collapsed += char
    previousChar = char
  }

  return collapsed
}

function splitTokens(text) {
  return text ? text.split(' ') : []
}

function createWeightedMap(entries = {}) {
  const weightedMap = new Map()

  for (const [rawText, rawWeight] of Object.entries(entries)) {
    const normalized = collapseRepeatedCharacters(normalizeCommentText(rawText))
    const weight = Number(rawWeight)

    if (normalized && Number.isFinite(weight) && weight > 0) {
      weightedMap.set(normalized, weight)
    }
  }

  return weightedMap
}

function normalizeThresholds(thresholds = {}) {
  return {
    allow: Number.isFinite(Number(thresholds.allow)) ? Number(thresholds.allow) : 0,
    review: Number.isFinite(Number(thresholds.review)) ? Number(thresholds.review) : 5,
    reject: Number.isFinite(Number(thresholds.reject)) ? Number(thresholds.reject) : 10
  }
}

function createWordTrie(wordWeights) {
  const root = {
    children: new Map(),
    weight: 0,
    word: ''
  }

  for (const [word, weight] of wordWeights.entries()) {
    let node = root

    for (const char of word) {
      if (!node.children.has(char)) {
        node.children.set(char, {
          children: new Map(),
          weight: 0,
          word: ''
        })
      }

      node = node.children.get(char)
    }

    node.weight = weight
    node.word = word
  }

  return root
}

function normalizeReplacement(replacement) {
  if (typeof replacement === 'string' && replacement.trim()) {
    return replacement.trim()
  }

  return '&!@#%'
}

export function createModerator(config) {
  const wordWeights = createWeightedMap(config.words)
  const phraseWeights = createWeightedMap(config.phrases)
  const thresholds = normalizeThresholds(config.thresholds)
  const wordTrie = createWordTrie(wordWeights)
  const replacement = normalizeReplacement(config.replacement)
  let maxWordLength = 0
  const phraseLengths = new Set()

  for (const word of wordWeights.keys()) {
    maxWordLength = Math.max(maxWordLength, word.length)
  }

  for (const phrase of phraseWeights.keys()) {
    phraseLengths.add(splitTokens(phrase).length)
  }

  function decide(score) {
    if (score <= thresholds.allow || score < thresholds.review) {
      return 'allow'
    }

    if (score < thresholds.reject) {
      return 'review'
    }

    return 'reject'
  }

  function findTokenMatches(token) {
    const tokenMatches = []

    for (let startIndex = 0; startIndex < token.length; startIndex += 1) {
      let node = wordTrie

      for (
        let index = startIndex;
        index < token.length && index < startIndex + maxWordLength;
        index += 1
      ) {
        node = node.children.get(token[index])

        if (!node) {
          break
        }

        if (node.weight) {
          tokenMatches.push({
            word: node.word,
            weight: node.weight
          })
        }
      }
    }

    return tokenMatches
  }

  return {
    config: {
      thresholds,
      replacement,
      logging: {
        includeText: Boolean(config.logging?.includeText)
      }
    },
    moderate(text) {
      const normalizedText = normalizeCommentText(text)
      const collapsedText = collapseRepeatedCharacters(normalizedText)
      const tokens = splitTokens(collapsedText)
      const matched = new Set()
      let score = 0
      let spacedRun = ''

      function addMatch(match, weight) {
        score += weight
        matched.add(match)
      }

      function checkSpacedRun() {
        const weight = wordWeights.get(spacedRun)

        if (weight && !matched.has(spacedRun)) {
          addMatch(spacedRun, weight)
        }
      }

      function checkToken(token) {
        for (const match of findTokenMatches(token)) {
          if (!matched.has(match.word)) {
            addMatch(match.word, match.weight)
          }
        }
      }

      for (const token of tokens) {
        checkToken(token)

        if (token.length === 1 && maxWordLength > 1) {
          spacedRun += token

          if (spacedRun.length > maxWordLength) {
            spacedRun = spacedRun.slice(1)
          }

          checkSpacedRun()
        } else {
          spacedRun = ''
        }
      }

      for (const phraseLength of phraseLengths) {
        if (phraseLength <= 1 || phraseLength > tokens.length) {
          continue
        }

        for (let index = 0; index <= tokens.length - phraseLength; index += 1) {
          const phrase = tokens.slice(index, index + phraseLength).join(' ')
          const weight = phraseWeights.get(phrase)

          if (weight) {
            addMatch(phrase, weight)
          }
        }
      }

      const action = decide(score)

      return {
        allowed: action === 'allow',
        action,
        score,
        matchedWords: Array.from(matched)
      }
    },
    sanitize(text) {
      const normalizedText = normalizeCommentText(text)
      const tokens = splitTokens(normalizedText)
      const sanitizedTokens = []

      function findSpacedWord(startIndex) {
        let candidate = ''

        for (
          let index = startIndex;
          index < tokens.length && candidate.length < maxWordLength;
          index += 1
        ) {
          if (tokens[index].length !== 1) {
            return undefined
          }

          candidate += collapseRepeatedCharacters(tokens[index])

          if (wordWeights.has(candidate)) {
            return {
              tokenCount: index - startIndex + 1
            }
          }
        }

        return undefined
      }

      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]
        const spacedWord = token.length === 1 ? findSpacedWord(index) : undefined

        if (spacedWord) {
          sanitizedTokens.push(replacement)
          index += spacedWord.tokenCount - 1
          continue
        }

        const collapsedToken = collapseRepeatedCharacters(token)

        sanitizedTokens.push(findTokenMatches(collapsedToken).length ? replacement : token)
      }

      return sanitizedTokens.join(' ')
    }
  }
}

export const commentModerator = createModerator(loadModerationConfig())

export function moderateComment(text) {
  return commentModerator.moderate(text)
}

export function sanitizeComment(text) {
  return commentModerator.sanitize(text)
}

export function getModerationLoggingConfig() {
  return commentModerator.config.logging
}
