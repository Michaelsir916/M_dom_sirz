

## Setup

```
npm install
```

`sharp` is used for the blur feature (Auto-Post). If it fails to install on
your server (some hosts need build tools for native modules), the bot still
runs fine — the blur toggle just stays unavailable until it's installed.

## New in this update

### Broadcast
- Send a photo/video/GIF with a caption starting `/broadcast`, or use the
  📢 Broadcast button in the admin panel (`/admin` → File Share), to
  broadcast media — not just text.
- 🔁 Forward ON/OFF toggle in the broadcast menu — ON uses `forwardMessage`
  (shows "Forwarded from"), OFF uses `copyMessage` (looks native).
- `/broadcasthistory` — last 10 broadcasts with sent/failed/blocked counts.
- Sending is now rate-limited (batched, ~25/sec) instead of a fixed 100ms
  delay, and automatically retries anyone who got rate-limited mid-send.
- Users who've blocked the bot are auto-flagged and skipped in future
  broadcasts.
- `/schedulebroadcast YYYY-MM-DD HH:MM your message` — schedule a text
  broadcast for a future time (IST). `/listscheduled` and
  `/cancelbroadcast <id>` manage pending ones. (Scheduled broadcasts are
  text-only for now — media broadcasts send immediately.)

### Auto-Post (🖼 Auto-Post button in the admin panel)
Fully isolated per admin — each admin configures and sees only their own:
- **Source Channel** — pick from known chats or type an ID/@username. I
  must already be a member/admin there. Videos posted here **from now on**
  are the pool Auto-Post pulls from (old history can't be fetched via the
  Bot API — only new posts are tracked). Must be different from your
  destination channel.
- **Destination Channel** — where the auto-posts themselves get sent.
- **Interval** — every X hours, a new (never-repeated) video's thumbnail
  gets auto-posted.
- **Caption** — one fixed caption used for every auto-post.
- **Thumbnail source** — either the video's own Telegram-generated
  thumbnail, or a custom photo you upload once.
- **Blur** — on/off, per admin/channel (needs `sharp` installed).
- **🧪 Test Preview** — at setup time, generates one preview in your DM
  with ✅ Post / ❌ Skip. Once you're happy and hit ▶️ Enable, the scheduler
  posts automatically every interval with no confirmation step.
- Every post includes a "🎬 Get Full Video" button — a deep link that
  delivers that exact video via the bot when tapped.
- **Retry/skip:** if a video's thumbnail can't be read/posted, it's retried
  on the next tick (max 2 attempts total); after that it's permanently
  skipped and never retried again.
- **Log channel reporting:** every retry, permanent skip, empty-queue tick,
  and unexpected error is reported to your `/setlogchannel` chat. The exact
  same message is only sent once per 5 minutes, so a stuck video won't
  flood the channel.

### Forward Protection
- 🔐 toggle in the admin panel — when ON, files the bot sends to users
  (via `/random`, auto-post deep-links, etc.) can't be forwarded or saved
  by the recipient (Telegram's `protect_content`).

### Force-Sub: per-group Pending mode
- In the admin panel → File Share → 📋 Force-Sub List, each group now has
  its own mode button:
  - **🔓 Auto-Approve** (previous behavior) — join requests are approved
    instantly.
  - **⏳ Pending** — join requests are *not* approved. The user still gets
    files right away (the request itself counts as verified), but they
    aren't actually let into the group unless/until it auto-approves.
- When a group is in Pending mode, an **⏱ Delay** button appears to choose
  how long until Telegram auto-approves the request in the background:
  Never (manual only) / 1h / 6h / 24h / 72h.
- Mixed setups are fine — some groups Auto, others Pending, each with their
  own delay.
