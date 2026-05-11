import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { createClient } from '@supabase/supabase-js'

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true })

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

// --- START MENU ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id

  bot.sendMessage(chatId, 'Choose action:', {
    reply_markup: {
      keyboard: [
        ['Report', 'Status']
      ],
      resize_keyboard: true
    }
  })
})

// --- MAIN MENU HANDLER ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (text === 'Report') {
    bot.sendMessage(chatId, 'Report status:', {
      reply_markup: {
        keyboard: [
          ['Open', 'Closed']
        ],
        resize_keyboard: true
      }
    })
  }

  if (text === 'Status') {
    const { data } = await supabase
      .from('reports')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (!data) {
      bot.sendMessage(chatId, 'No reports yet')
      return
    }

    const time = new Date(data.created_at)
    const minutes = Math.floor((Date.now() - time) / 60000)

    bot.sendMessage(
      chatId,
      `Last status: ${data.status.toUpperCase()} (${minutes} min ago)`
    )
  }

  if (text === 'Open' || text === 'Closed') {
    await supabase.from('reports').insert({
      store_id: 'store_1',
      status: text.toLowerCase()
    })

    bot.sendMessage(chatId, `Recorded: ${text}`)
  }
})