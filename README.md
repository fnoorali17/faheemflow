# FaheemFlow

Personal task manager + habit tracker with Google Calendar sync.

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
3. Generate a domain in Settings → Networking
4. Add environment variables (see below)

---

## Google Calendar Setup

Once deployed, add these three environment variables in Railway:
**Settings → Variables → Add Variable**

| Variable | Where to get it |
|---|---|
| `GCAL_CLIENT_ID` | Google Cloud Console → Credentials → OAuth client |
| `GCAL_CLIENT_SECRET` | Same OAuth client |
| `GCAL_REFRESH_TOKEN` | OAuth Playground (see below) |

### Getting your refresh token (5 minutes)

1. Go to [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
2. Click ⚙️ gear → check "Use your own OAuth credentials"
3. Enter your Client ID and Client Secret
4. In the left panel find **Google Calendar API v3** → select `https://www.googleapis.com/auth/calendar`
5. Click **Authorize APIs** → sign in → Allow
6. Click **Exchange authorization code for tokens**
7. Copy the **Refresh token**

Add all three values to Railway → redeploy → the "Sync to Google Cal" button will appear.

### What the sync does

- Pushes all pending tasks with due dates to your primary Google Calendar
- Creates all-day events with priority, pomodoro estimate, project, and tags in the description
- Color codes events: red (P1), orange (P2), blue (P3+)
- Updates existing events if you re-sync after changing a due date
- Never duplicates — tracks which tasks have already been pushed

---

## Adding to iPhone home screen

1. Open your Railway URL in Safari
2. Tap Share → Add to Home Screen
3. Name it FaheemFlow → Add

Opens full-screen like a native app.

---

## Tech stack

| | |
|---|---|
| Server | Node.js + Express |
| Database | SQLite (better-sqlite3) |
| Frontend | Vanilla HTML/CSS/JS |
| Calendar | Google Calendar API v3 |
| Deployment | Railway |
