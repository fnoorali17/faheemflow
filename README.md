# Irada

Personal task manager + habit tracker with Google Calendar sync.

> **Irada** (إرادة) — Arabic for will, intention, purpose.
> *Direct your will.*

---

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

---

## Deploy to Railway

1. Push to GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Generate a domain in Settings → Networking → Custom Domain: `irada.work`
4. Add environment variables (see below)

---

## Google Calendar Setup

Once deployed, add these environment variables in Railway:
**Settings → Variables → Add Variable**

| Variable | Where to get it |
|---|---|
| `GOOGLE_CLIENT_ID` | Google Cloud Console → Credentials → OAuth client |
| `GOOGLE_CLIENT_SECRET` | Same OAuth client |
| `GCAL_CLIENT_ID` | Same as `GOOGLE_CLIENT_ID` |
| `GCAL_CLIENT_SECRET` | Same as `GOOGLE_CLIENT_SECRET` |

Set the OAuth callback URLs in Google Cloud Console:
- `https://irada.work/api/auth/google/callback`
- `https://irada.work/api/gcal/callback`

---

## Environment Variables

| Variable | Description |
|---|---|
| `ADMIN_SECRET` | Secret for creating user accounts via admin endpoint |
| `SESSION_SECRET` | Random string for signing session cookies |
| `RESEND_API_KEY` | Resend API key for password reset emails |
| `FROM_EMAIL` | From address for emails (e.g. `hello@send.irada.work`) |
| `APP_URL` | Full app URL (e.g. `https://irada.work`) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (for SSO + Calendar) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GCAL_CLIENT_ID` | Same as GOOGLE_CLIENT_ID |
| `GCAL_CLIENT_SECRET` | Same as GOOGLE_CLIENT_SECRET |
| `GCAL_REFRESH_TOKEN` | Master fallback GCal token (per-user tokens stored in DB) |
| `TODOIST_API_TOKEN` | Legacy fallback Todoist token |
| `TICKTICK_ACCESS_TOKEN` | Legacy fallback TickTick token |

---

## Adding to iPhone home screen

1. Open https://irada.work in Safari
2. Tap Share → Add to Home Screen
3. Name it "Irada" → Add

Opens full-screen like a native app.

---

## iOS Widget

1. Install Scriptable (free, App Store)
2. Open `Irada-Widget.js`, paste into Scriptable
3. Set your `APP_URL`, `EMAIL`, `PASSWORD`
4. Add widget to home screen → choose Scriptable

---

## Admin: create a user account

```bash
curl -X POST https://irada.work/admin/create-user \
  -H "Content-Type: application/json" \
  -d '{"adminSecret":"YOUR_ADMIN_SECRET","email":"you@example.com","password":"pass","name":"Your Name"}'
```

---

## Tech stack

| | |
|---|---|
| Server | Node.js + Express |
| Database | SQLite (better-sqlite3) |
| Frontend | Vanilla HTML/CSS/JS |
| Calendar | Google Calendar API v3 |
| Auth | Email/password + Google SSO |
| Email | Resend |
| Deployment | Railway |
