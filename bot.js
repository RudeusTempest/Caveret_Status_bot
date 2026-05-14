import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { createClient } from '@supabase/supabase-js'

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true })

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

const localTimeZone = process.env.LOCAL_TIME_ZONE || 'Asia/Jerusalem'
const reportCooldownMs = 3 * 60 * 1000

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

const reservedRemarkTexts = new Set([
  labels.addRemark,
  labels.finish
])

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
const lastReportTimes = new Map()
const pendingReportTtlMs = 10 * 60 * 1000
const todayReportsLimit = 50

function clearCooldownAfterExpiry(reporterId, reportTime) {
  setTimeout(() => {
    if (lastReportTimes.get(reporterId) === reportTime) {
      lastReportTimes.delete(reporterId)
    }
  }, reportCooldownMs + 1000).unref()
}

function setPendingReport(chatId, state) {
  pendingReports.set(chatId, {
    ...state,
    expiresAt: Date.now() + pendingReportTtlMs
  })
}

function getPendingReport(chatId) {
  const pendingReport = pendingReports.get(chatId)

  if (pendingReport?.expiresAt && pendingReport.expiresAt < Date.now()) {
    pendingReports.delete(chatId)
    return undefined
  }

  return pendingReport
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
    .select('created_at,status,remark')
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString())
    .order('created_at', { ascending: false })
    .limit(todayReportsLimit)

  return data || []
}

async function getLatestTodayReport() {
  const { start, end } = getCurrentLocalDayRange(localTimeZone)
  const { data } = await supabase
    .from('reports')
    .select('created_at,status,remark')
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString())
    .order('created_at', { ascending: false })
    .limit(1)

  return data?.[0]
}

function getReporterId(msg) {
  return msg.from?.id ?? msg.chat.id
}

function getCooldownRemainingMs(reporterId) {
  const lastReportTime = lastReportTimes.get(reporterId)

  if (!lastReportTime) {
    return 0
  }

  return Math.max(0, reportCooldownMs - (Date.now() - lastReportTime))
}

function getCooldownMessage(remainingMs) {
  const remainingMinutes = Math.ceil(remainingMs / 60000)

  if (remainingMinutes === 1) {
    return 'אפשר לשלוח דיווח נוסף בעוד דקה.'
  }

  return `אפשר לשלוח דיווח נוסף בעוד ${remainingMinutes} דקות.`
}

function normalizeRemark(remark) {
  if (typeof remark !== 'string') {
    return ''
  }

  const trimmedRemark = remark.trim()

  if (!trimmedRemark || reservedRemarkTexts.has(trimmedRemark)) {
    return ''
  }

  return trimmedRemark
}

async function saveReport(chatId, reporterId, status, remark) {
  const cooldownRemainingMs = getCooldownRemainingMs(reporterId)

  if (cooldownRemainingMs > 0) {
    pendingReports.delete(chatId)
    bot.sendMessage(chatId, getCooldownMessage(cooldownRemainingMs), mainKeyboard)
    return false
  }

  const report = {
    store_id: 'store_1',
    status
  }

  const normalizedRemark = normalizeRemark(remark)

  if (normalizedRemark) {
    report.remark = normalizedRemark
  }

  const { error } = await supabase.from('reports').insert(report)

  if (error) {
    console.error('Failed to save report:', error)
    bot.sendMessage(chatId, 'לא ניתן לשמור את הדיווח.')
    return false
  }

  pendingReports.delete(chatId)
  const reportTime = Date.now()
  lastReportTimes.set(reporterId, reportTime)
  clearCooldownAfterExpiry(reporterId, reportTime)
  bot.sendMessage(chatId, `נשמר: ${statusText[status] ?? status}`, mainKeyboard)
  return true
}

// --- START MENU ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id

  bot.sendMessage(chatId, 'בחר פעולה:', mainKeyboard)
})

bot.on('polling_error', (error) => {
  console.error('Telegram polling error:', error.code, error.message)
})

// --- MAIN MENU HANDLER ---
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id
    const reporterId = getReporterId(msg)
    const text = msg.text

    if (!text) {
      return
    }

    if (commands.report.has(text)) {
      const cooldownRemainingMs = getCooldownRemainingMs(reporterId)

      if (cooldownRemainingMs > 0) {
        pendingReports.delete(chatId)
        bot.sendMessage(chatId, getCooldownMessage(cooldownRemainingMs), mainKeyboard)
        return
      }

      setPendingReport(chatId, { awaitingStatus: true })
      bot.sendMessage(chatId, 'דווח סטטוס:', reportKeyboard)
      return
    }

    const pendingReport = getPendingReport(chatId)

    if (pendingReport?.awaitingRemark) {
      if (commands.finish.has(text)) {
        await saveReport(chatId, reporterId, pendingReport.status)
        return
      }

      const remark = normalizeRemark(text)

      if (!remark) {
        bot.sendMessage(chatId, 'כתוב הערה:')
        return
      }

      await saveReport(chatId, reporterId, pendingReport.status, remark)
      return
    }

    if (commands.addRemark.has(text)) {
      if (!pendingReport?.status) {
        setPendingReport(chatId, { awaitingStatus: true })
        bot.sendMessage(chatId, 'בחר קודם סטטוס:', statusKeyboard)
        return
      }

      setPendingReport(chatId, {
        ...pendingReport,
        awaitingRemark: true
      })
      bot.sendMessage(chatId, 'כתוב הערה:')
      return
    }

    if (commands.finish.has(text)) {
      if (!pendingReport?.status) {
        setPendingReport(chatId, { awaitingStatus: true })
        bot.sendMessage(chatId, 'בחר קודם סטטוס:', statusKeyboard)
        return
      }

      await saveReport(chatId, reporterId, pendingReport.status)
      return
    }

    if (commands.status.has(text)) {
      const latestReport = await getLatestTodayReport()

      if (!latestReport) {
        bot.sendMessage(chatId, 'לא נשלחו דיווחים היום.')
        return
      }

      const statusTime = formatReportTime(latestReport)
      const currentStatus = statusText[latestReport.status] ?? latestReport.status
      const currentStatusIcon = statusIcon[latestReport.status] ?? ''
      const latestRemark = normalizeRemark(latestReport.remark)
      const remarkLine = latestRemark ? `\nהערה: ${latestRemark}` : ''

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
        const normalizedRemark = normalizeRemark(report.remark)
        const remark = normalizedRemark ? ` - ${normalizedRemark}` : ''
        return `${formatReportTime(report)} - ${reportStatus} ${reportIcon}${remark}`
      })

      const limitedMessage = reports.length === todayReportsLimit
        ? `דיווחים אחרונים (${todayReportsLimit} אחרונים):`
        : 'דיווחים אחרונים:'

      bot.sendMessage(chatId, `${limitedMessage}\n${reportLines.join('\n')}`)
    }

    if (text in statusByText) {
      const status = statusByText[text]
      const pendingReport = getPendingReport(chatId)

      if (pendingReport?.awaitingStatus) {
        setPendingReport(chatId, { status })
        bot.sendMessage(chatId, 'להוסיף הערה?', remarkKeyboard)
        return
      }

      await saveReport(chatId, reporterId, status)
    }
  } catch (error) {
    console.error('Message handler failed:', error)
  }
})

async function shutdown(signal) {
  console.log(`${signal} received, stopping Telegram polling`)
  await bot.stopPolling()
  process.exit(0)
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
