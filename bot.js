import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { createClient } from '@supabase/supabase-js'

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true })

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

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
    const { data } = await supabase
      .from('reports')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (!data) {
      bot.sendMessage(chatId, 'אין דיווחים עדיין')
      return
    }

    const time = new Date(data.created_at)
    const minutes = Math.floor((Date.now() - time) / 60000)
    const statusTime = time.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
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
