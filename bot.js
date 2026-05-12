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
  todayReports: 'דיווחי היום',
  addRemark: 'הוסף הערה',
  finish: 'סיום (ללא הערה)',
  open: 'פתוח',
  closed: 'סגור'
}

const commands = {
  report: new Set([labels.report, 'Report']),
  status: new Set([labels.status, 'Status']),
  todayReports: new Set([labels.todayReports]),
  addRemark: new Set([labels.addRemark]),
  finish: new Set([labels.finish])
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

const statusIcon = {
  open: '🟢',
  closed: '🔴'
}

const mainKeyboard = {
  reply_markup: {
    keyboard: [
      [labels.report, labels.status],
      [labels.todayReports]
    ],
    resize_keyboard: true
  }
}

const reportKeyboard = {
  reply_markup: {
    keyboard: [
      [labels.open, labels.closed]
    ],
    resize_keyboard: true
  }
}

const statusKeyboard = {
  reply_markup: {
    keyboard: [
      [labels.open, labels.closed]
    ],
    resize_keyboard: true
  }
}

const remarkKeyboard = {
  reply_markup: {
    keyboard: [
      [labels.addRemark, labels.finish]
    ],
    resize_keyboard: true
  }
}

const pendingReports = new Map()

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

function formatReportTime(report) {
  return new Date(report.created_at).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: localTimeZone
  })
}

async function getTodayReports() {
  const { start, end } = getCurrentLocalDayRange(localTimeZone)
  const { data } = await supabase
    .from('reports')
    .select('*')
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString())
    .order('created_at', { ascending: false })

  return data || []
}

async function saveReport(chatId, status, remark) {
  const report = {
    store_id: 'store_1',
    status
  }

  if (remark) {
    report.remark = remark
  }

  const { error } = await supabase.from('reports').insert(report)

  if (error) {
    console.error('Failed to save report:', error)
    bot.sendMessage(chatId, 'לא ניתן לשמור את הדיווח.')
    return false
  }

  pendingReports.delete(chatId)
  bot.sendMessage(chatId, `נשמר: ${statusText[status] ?? status}`, mainKeyboard)
  return true
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
    pendingReports.set(chatId, { awaitingStatus: true })
    bot.sendMessage(chatId, 'דווח סטטוס:', reportKeyboard)
    return
  }

  const pendingReport = pendingReports.get(chatId)

  if (pendingReport?.awaitingRemark) {
    const remark = text.trim()

    if (!remark) {
      bot.sendMessage(chatId, 'כתוב הערה:')
      return
    }

    await saveReport(chatId, pendingReport.status, remark)
    return
  }

  if (commands.addRemark.has(text)) {
    if (!pendingReport?.status) {
      pendingReports.set(chatId, { awaitingStatus: true })
      bot.sendMessage(chatId, 'בחר קודם סטטוס:', statusKeyboard)
      return
    }

    pendingReports.set(chatId, {
      ...pendingReport,
      awaitingRemark: true
    })
    bot.sendMessage(chatId, 'כתוב הערה:')
    return
  }

  if (commands.finish.has(text)) {
    if (!pendingReport?.status) {
      pendingReports.set(chatId, { awaitingStatus: true })
      bot.sendMessage(chatId, 'בחר קודם סטטוס:', statusKeyboard)
      return
    }

    await saveReport(chatId, pendingReport.status)
    return
  }

  if (commands.status.has(text)) {
    const reports = await getTodayReports()

    if (!reports.length) {
      bot.sendMessage(chatId, 'לא נשלחו דיווחים היום.')
      return
    }

    const latestReport = reports[0]
    const statusTime = formatReportTime(latestReport)
    const currentStatus = statusText[latestReport.status] ?? latestReport.status
    const currentStatusIcon = statusIcon[latestReport.status] ?? ''
    const remarkLine = latestReport.remark ? `\nהערה: ${latestReport.remark}` : ''

    bot.sendMessage(
      chatId,
      `סטטוס: ${currentStatus} ${currentStatusIcon}
דיווח אחרון: ${statusTime}${remarkLine}`
    )
  }

  if (commands.todayReports.has(text)) {
    const reports = await getTodayReports()

    if (!reports.length) {
      bot.sendMessage(chatId, 'לא נשלחו דיווחים היום.')
      return
    }

    const reportLines = reports.map((report) => {
      const reportStatus = statusText[report.status] ?? report.status
      const reportIcon = statusIcon[report.status] ?? ''
      const remark = report.remark ? ` - ${report.remark}` : ''
      return `${formatReportTime(report)} - ${reportStatus} ${reportIcon}${remark}`
    })

    bot.sendMessage(chatId, `דיווחים אחרונים:\n${reportLines.join('\n')}`)
  }

  if (text in statusByText) {
    const status = statusByText[text]
    const pendingReport = pendingReports.get(chatId)

    if (pendingReport?.awaitingStatus) {
      pendingReports.set(chatId, { status })
      bot.sendMessage(chatId, 'להוסיף הערה?', remarkKeyboard)
      return
    }

    await saveReport(chatId, status)
  }
})
