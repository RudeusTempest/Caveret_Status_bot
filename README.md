# Caveret Status Bot

A Telegram bot for crowd-reporting whether the Caveret store is open or closed. Users submit status reports, with an optional remark, and anyone can check the current status or see today's reports. The bot's interface is in Hebrew, and reports are stored in Supabase.

## Features

- **Report (דיווח):** submit `open` / `closed`, with an optional remark. Each user can report once every 3 minutes.
- **Status (סטטוס):** shows the latest status reported today and when it was reported.
- **Today's reports (דיווחי היום):** lists up to 50 of today's reports.
- **Analytics (נתוני שימוש / `/analytics`):** daily usage stats, for admins only.
- **Remark moderation:** remarks are scored against a word list. Remarks that cross the threshold are censored before they're saved.

"Today" is calculated in `LOCAL_TIME_ZONE` (default `Asia/Jerusalem`).

## Setup

Requires Node.js 18 or later.

```bash
npm install
cp .env.example .env   # then fill in the values
npm start
```

### Environment variables

| Variable | Description |
| --- | --- |
| `TELEGRAM_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase API key |
| `LOCAL_TIME_ZONE` | IANA time zone that sets when a day starts and ends (default `Asia/Jerusalem`) |
| `ADMIN_USER_IDS` | Comma-separated Telegram user IDs that can view analytics |
| `COMMENT_MODERATION_CONFIG_FILE` | *(optional)* Path to a moderation config to use instead of `moderation-rules.json` |
| `COMMENT_MODERATION_CONFIG_JSON` | *(optional)* Inline JSON moderation config, which overrides the file |

### Database

Run [supabase_analytics.sql](supabase_analytics.sql) in the Supabase SQL editor. It creates the `reports`, `bot_users` and `analytics_events` tables and their indexes. The script is safe to re-run on an existing database.

## Moderation

[moderation-rules.json](moderation-rules.json) sets:

- `words` / `phrases`: terms and their scores
- `thresholds`: the scores at which a remark is allowed, flagged for review or rejected
- `replacement`: the string that replaces censored terms
- `logging.includeText`: whether the remark text is included in moderation logs

Before matching, text is normalized: it is lowercased, punctuation is stripped, and Hebrew final letters are handled.

## Project structure

```
bot.js                  Bot entry point: handlers, reporting flow, analytics
moderation.js           Remark normalization, scoring and sanitizing
moderation-rules.json   Default moderation config
supabase_analytics.sql  Database schema (reports, users, analytics)
index.js                One-off Supabase connectivity test script
```
