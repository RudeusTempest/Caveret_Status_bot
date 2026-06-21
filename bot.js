import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { createClient } from '@supabase/supabase-js'
import { getModerationLoggingConfig, moderateComment, sanitizeComment } from './moderation.js'

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
  analytics: 'נתוני שימוש',
  addRemark: 'הוסף הערה',
  finish: 'סיום (ללא הערה)',
  cancel: 'ביטול',
  open: 'פתוח',
  closed: 'סגור'
}

const commands = {
  report: new Set([labels.report, 'Report']),
  status: new Set([labels.status, 'Status']),
  todayReports: new Set([labels.todayReports]),
  analytics: new Set([labels.analytics, '/analytics', 'Analytics']),
  addRemark: new Set([labels.addRemark]),
  finish: new Set([labels.finish]),
  cancel: new Set([labels.cancel, 'Cancel'])
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
  labels.finish,
  labels.cancel
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
      [labels.open, labels.closed],
      [labels.cancel]
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
      [labels.addRemark, labels.finish],
      [labels.cancel]
    ],
    resize_keyboard: true
  }
}

const pendingReports = new Map()
const lastReportTimes = new Map()
const pendingReportTtlMs = 10 * 60 * 1000
const todayReportsLimit = 50
const analyticsUsersLimit = 20
const adminUserIds = new Set(
  (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
)

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

function getDisplayName(user = {}) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ')

  return fullName || user.username || String(user.id || '')
}

function getUserProfile(msg) {
  const user = msg.from || {}

  return {
    telegram_user_id: user.id ? String(user.id) : String(msg.chat.id),
    chat_id: String(msg.chat.id),
    username: user.username || null,
    first_name: user.first_name || null,
    last_name: user.last_name || null,
    display_name: getDisplayName(user),
    language_code: user.language_code || null,
    is_bot: Boolean(user.is_bot)
  }
}

function isAdmin(msg) {
  if (!adminUserIds.size) {
    return false
  }

  return adminUserIds.has(String(getReporterId(msg)))
}

function formatUserName(user = {}) {
  const displayName = user.reporter_name || user.display_name || user.first_name || user.username
  const username = user.username ? `@${user.username}` : ''

  if (displayName && username && displayName !== username) {
    return `${displayName} (${username})`
  }

  return displayName || username || `ID ${user.telegram_user_id || 'unknown'}`
}

async function saveBotUser(msg) {
  const profile = getUserProfile(msg)

  const { error } = await supabase
    .from('bot_users')
    .upsert(
      {
        telegram_user_id: profile.telegram_user_id,
        username: profile.username,
        first_name: profile.first_name,
        last_name: profile.last_name,
        display_name: profile.display_name,
        language_code: profile.language_code,
        is_bot: profile.is_bot,
        last_seen_at: new Date().toISOString()
      },
      { onConflict: 'telegram_user_id' }
    )

  if (error) {
    console.error('Failed to save bot user:', error)
  }

  return profile
}

async function logAnalyticsEvent(msg, eventType, metadata = {}) {
  const profile = await saveBotUser(msg)

  const { error } = await supabase
    .from('analytics_events')
    .insert({
      event_type: eventType,
      telegram_user_id: profile.telegram_user_id,
      chat_id: profile.chat_id,
      username: profile.username,
      display_name: profile.display_name,
      metadata
    })

  if (error) {
    console.error('Failed to save analytics event:', error)
  }

  return profile
}

async function getTodayReports() {
  const { start, end } = getCurrentLocalDayRange(localTimeZone)
  const { data } = await supabase
    .from('reports')
    .select('created_at,status,remark,telegram_user_id,username,reporter_name')
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
    .select('created_at,status,remark,telegram_user_id,username,reporter_name')
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString())
    .order('created_at', { ascending: false })
    .limit(1)

  return data?.[0]
}

async function getTodayAnalytics() {
  const { start, end } = getCurrentLocalDayRange(localTimeZone)
  const [eventsResult, reportsResult] = await Promise.all([
    supabase
      .from('analytics_events')
      .select('event_type,telegram_user_id,username,display_name,created_at')
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .order('created_at', { ascending: true })
      .limit(5000),
    supabase
      .from('reports')
      .select('created_at,status,remark,telegram_user_id,username,reporter_name')
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .order('created_at', { ascending: false })
      .limit(5000)
  ])

  if (eventsResult.error) {
    throw eventsResult.error
  }

  if (reportsResult.error) {
    throw reportsResult.error
  }

  return {
    events: eventsResult.data || [],
    reports: reportsResult.data || []
  }
}

function buildTodayAnalyticsMessage(events, reports) {
  const users = new Map()
  const eventTotals = {
    press_status: 0,
    press_today_reports: 0,
    press_report: 0
  }

  function getUserStats(user) {
    const key = user.telegram_user_id || 'unknown'

    if (!users.has(key)) {
      users.set(key, {
        telegram_user_id: user.telegram_user_id,
        username: user.username,
        display_name: user.display_name || user.reporter_name,
        press_status: 0,
        press_today_reports: 0,
        press_report: 0,
        submit_report: 0
      })
    }

    const stats = users.get(key)
    stats.username ||= user.username
    stats.display_name ||= user.display_name || user.reporter_name

    return stats
  }

  for (const event of events) {
    if (event.event_type in eventTotals) {
      eventTotals[event.event_type] += 1
      getUserStats(event)[event.event_type] += 1
    } else if (event.telegram_user_id) {
      getUserStats(event)
    }
  }

  for (const report of reports) {
    const stats = getUserStats(report)
    stats.submit_report += 1
  }

  const userStats = [...users.values()]
    .sort((a, b) => {
      const totalA = a.press_status + a.press_today_reports + a.press_report + a.submit_report
      const totalB = b.press_status + b.press_today_reports + b.press_report + b.submit_report
      return totalB - totalA
    })
    .slice(0, analyticsUsersLimit)

  const userLines = userStats.map((user, index) => (
    `${index + 1}. ${formatUserName(user)} - סטטוס: ${user.press_status}, דיווחי היום: ${user.press_today_reports}, התחיל דיווח: ${user.press_report}, שלח דיווח: ${user.submit_report}`
  ))

  const reportLines = reports.slice(0, todayReportsLimit).map((report) => {
    const reportStatus = statusText[report.status] ?? report.status
    const reportIcon = statusIcon[report.status] ?? ''
    const normalizedRemark = normalizeRemark(report.remark)
    const remark = normalizedRemark ? ` - ${normalizedRemark}` : ''
    return `${formatReportTime(report)} - ${reportStatus} ${reportIcon} - ${formatUserName(report)}${remark}`
  })

  return [
    'נתוני שימוש היום:',
    `משתמשים שונים: ${users.size}`,
    `לחצו סטטוס: ${eventTotals.press_status}`,
    `לחצו דיווחי היום: ${eventTotals.press_today_reports}`,
    `התחילו דיווח: ${eventTotals.press_report}`,
    `שלחו דיווח: ${reports.length}`,
    '',
    'לפי משתמש:',
    userLines.length ? userLines.join('\n') : 'אין פעילות היום.',
    '',
    'דיווחים היום:',
    reportLines.length ? reportLines.join('\n') : 'לא נשלחו דיווחים היום.'
  ].join('\n')
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

function cancelPendingReport(chatId) {
  pendingReports.delete(chatId)
  bot.sendMessage(chatId, 'הדיווח בוטל.', mainKeyboard)
}

function collapseRemarkWhitespace(remark) {
  let collapsed = ''
  let previousWasSpace = true

  for (const char of remark.trim()) {
    const isSpace = char === ' ' || char === '\n' || char === '\r' || char === '\t'

    if (isSpace) {
      if (!previousWasSpace) {
        collapsed += ' '
        previousWasSpace = true
      }
      continue
    }

    collapsed += char
    previousWasSpace = false
  }

  return collapsed
}

function normalizeRemark(remark) {
  if (typeof remark !== 'string') {
    return ''
  }

  const trimmedRemark = collapseRemarkWhitespace(remark)

  if (!trimmedRemark || reservedRemarkTexts.has(trimmedRemark)) {
    return ''
  }

  return trimmedRemark
}

function logModeration(reporterId, moderationResult, remark) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    userId: reporterId,
    score: moderationResult.score,
    action: moderationResult.action
  }

  if (getModerationLoggingConfig().includeText) {
    logEntry.text = remark
  }

  console.log('Comment moderation:', logEntry)
}

async function saveReport(msg, status, remark) {
  const chatId = msg.chat.id
  const reporterId = getReporterId(msg)
  const cooldownRemainingMs = getCooldownRemainingMs(reporterId)

  if (cooldownRemainingMs > 0) {
    pendingReports.delete(chatId)
    bot.sendMessage(chatId, getCooldownMessage(cooldownRemainingMs), mainKeyboard)
    return false
  }

  const profile = await saveBotUser(msg)
  const report = {
    store_id: 'store_1',
    status,
    telegram_user_id: profile.telegram_user_id,
    chat_id: profile.chat_id,
    username: profile.username,
    reporter_name: profile.display_name
  }

  const normalizedRemark = normalizeRemark(remark)

  if (normalizedRemark) {
    const moderationResult = moderateComment(normalizedRemark)

    if (moderationResult.action !== 'allow') {
      logModeration(reporterId, moderationResult, normalizedRemark)
    }

    report.remark = moderationResult.action === 'allow'
      ? normalizedRemark
      : sanitizeComment(normalizedRemark)
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
  await logAnalyticsEvent(msg, 'submit_report', { status, has_remark: Boolean(normalizedRemark) })
  bot.sendMessage(chatId, `נשמר: ${statusText[status] ?? status}`, mainKeyboard)
  return true
}

// --- START MENU ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id

  logAnalyticsEvent(msg, 'start').catch((error) => {
    console.error('Failed to log start:', error)
  })
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
      await logAnalyticsEvent(msg, 'press_report')
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

    if (commands.cancel.has(text)) {
      if (pendingReport) {
        await logAnalyticsEvent(msg, 'cancel_report')
        cancelPendingReport(chatId)
        return
      }

      bot.sendMessage(chatId, 'בחר פעולה:', mainKeyboard)
      return
    }

    if (pendingReport?.awaitingRemark) {
      if (commands.finish.has(text)) {
        await logAnalyticsEvent(msg, 'finish_without_remark')
        await saveReport(msg, pendingReport.status)
        return
      }

      const remark = normalizeRemark(text)

      if (!remark) {
        bot.sendMessage(chatId, 'כתוב הערה:')
        return
      }

      await saveReport(msg, pendingReport.status, remark)
      return
    }

    if (commands.addRemark.has(text)) {
      await logAnalyticsEvent(msg, 'press_add_remark')
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
      await logAnalyticsEvent(msg, 'finish_without_remark')
      if (!pendingReport?.status) {
        setPendingReport(chatId, { awaitingStatus: true })
        bot.sendMessage(chatId, 'בחר קודם סטטוס:', statusKeyboard)
        return
      }

      await saveReport(msg, pendingReport.status)
      return
    }

    if (commands.status.has(text)) {
      await logAnalyticsEvent(msg, 'press_status')
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
      const reporterLine = latestReport.telegram_user_id
        ? `\nדווח על ידי: ${formatUserName(latestReport)}`
        : ''

      bot.sendMessage(
        chatId,
        `סטטוס: ${currentStatus} ${currentStatusIcon}
דיווח אחרון: ${statusTime}${reporterLine}${remarkLine}`
      )
    }

    if (commands.todayReports.has(text)) {
      await logAnalyticsEvent(msg, 'press_today_reports')
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
        const reporter = report.telegram_user_id ? ` - ${formatUserName(report)}` : ''
        return `${formatReportTime(report)} - ${reportStatus} ${reportIcon}${reporter}${remark}`
      })

      const limitedMessage = reports.length === todayReportsLimit
        ? `דיווחים אחרונים (${todayReportsLimit} אחרונים):`
        : 'דיווחים אחרונים:'

      bot.sendMessage(chatId, `${limitedMessage}\n${reportLines.join('\n')}`)
    }

    if (commands.analytics.has(text)) {
      await logAnalyticsEvent(msg, 'press_analytics')

      if (!isAdmin(msg)) {
        bot.sendMessage(chatId, 'אין הרשאה לצפות בנתוני שימוש.')
        return
      }

      const { events, reports } = await getTodayAnalytics()
      bot.sendMessage(chatId, buildTodayAnalyticsMessage(events, reports))
      return
    }

    if (text in statusByText) {
      const status = statusByText[text]
      const pendingReport = getPendingReport(chatId)

      if (pendingReport?.awaitingStatus) {
        await logAnalyticsEvent(msg, 'choose_report_status', { status })
        setPendingReport(chatId, { status })
        bot.sendMessage(chatId, 'להוסיף הערה?', remarkKeyboard)
        return
      }

      await saveReport(msg, status)
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
