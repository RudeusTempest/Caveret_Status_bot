import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { createClient } from '@supabase/supabase-js'

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true })

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

const localTimeZone = process.env.LOCAL_TIME_ZONE || 'Asia/Jerusalem'

const labels = {
  report: 'דיווח',
  status: 'סטטוס',
  open: 'פתוח',
  closed: 'סגור'
}

const commands = {
  report: new Set([labels.report, 'Report']),
  status: new Set([labels.status, 'Status'])
}

const statusByText = {
  [labels.open]: 'open',
  [labels.closed]: 'closed',
  Open: 'open',
  Closed: 'closed'
}

const statusText = {
  open: labels.open,
  closed: labels.closed
}

const mainKeyboard = {
  reply_markup: {
    keyboard: [
      [labels.report, labels.status]
    ],
    resize_keyboard: true
  }
}

function getTimeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  })

  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)])
  )
}

function getTimeZoneOffset(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone)
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  )

  return localAsUtc - date.getTime()
}

function zonedDateTimeToUtc({ year, month, day }, timeZone) {
  const localAsUtc = Date.UTC(year, month - 1, day)
  const firstGuess = new Date(localAsUtc)
  const offset = getTimeZoneOffset(firstGuess, timeZone)
  const secondGuess = new Date(localAsUtc - offset)
  const correctedOffset = getTimeZoneOffset(secondGuess, timeZone)

  return new Date(localAsUtc - correctedOffset)
}

function addLocalDay({ year, month, day }) {
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1))

  return {
    year: nextDay.getUTCFullYear(),
    month: nextDay.getUTCMonth() + 1,
    day: nextDay.getUTCDate()
  }
}

function getCurrentLocalDayRange(timeZone) {
  const now = new Date()
  const today = getTimeZoneParts(now, timeZone)
  const todayDate = {
    year: today.year,
    month: today.month,
    day: today.day
  }

  return {
    start: zonedDateTimeToUtc(todayDate, timeZone),
    end: zonedDateTimeToUtc(addLocalDay(todayDate), timeZone)
  }
}

// --- START MENU ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id

  bot.sendMessage(chatId, 'בחר פעולה:', mainKeyboard)
})

// --- MAIN MENU HANDLER ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (!text) {
    return
  }

  if (commands.report.has(text)) {
    bot.sendMessage(chatId, 'דווח סטטוס:', {
      reply_markup: {
        keyboard: [
          [labels.open, labels.closed]
        ],
        resize_keyboard: true
      }
    })
  }

  if (commands.status.has(text)) {
    const { start, end } = getCurrentLocalDayRange(localTimeZone)
    const { data } = await supabase
      .from('reports')
      .select('*')
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!data) {
      bot.sendMessage(chatId, 'לא נשלחו דיווחים היום.')
      return
    }

    const time = new Date(data.created_at)
    const minutes = Math.floor((Date.now() - time) / 60000)
    const statusTime = time.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: localTimeZone
    })
    const timeAgo = minutes === 1 ? 'לפני דקה' : `לפני ${minutes} דקות`
    const currentStatus = statusText[data.status] ?? data.status

    bot.sendMessage(
      chatId,
      `סטטוס אחרון: ${currentStatus} בשעה ${statusTime} (${timeAgo})`
    )
  }

  if (text in statusByText) {
    const status = statusByText[text]

    await supabase.from('reports').insert({
      store_id: 'store_1',
      status
    })

    bot.sendMessage(chatId, `נשמר: ${text}`, mainKeyboard)
  }
})
