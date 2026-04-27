// FaheemFlow — iOS Home Screen Widget
// ─────────────────────────────────────
// SETUP:
// 1. Install Scriptable from the App Store (free)
// 2. Open Scriptable → tap + → paste this entire script
// 3. Name it "FaheemFlow Widget"
// 4. Set YOUR_APP_URL below to your Railway URL
// 5. Set YOUR_EMAIL and YOUR_PASSWORD to your FaheemFlow login
// 6. On your home screen: long press → + → Scriptable → choose size
// ─────────────────────────────────────

const APP_URL = "https://YOUR-APP.up.railway.app"; // ← change this
const EMAIL = "your@email.com";                      // ← change this
const PASSWORD = "yourpassword";                     // ← change this

// Colors
const BG = new Color("#f7f6f3");
const SURFACE = new Color("#ffffff");
const ACCENT = new Color("#3b6fd4");
const GREEN = new Color("#1a7a4a");
const ORANGE = new Color("#c95a1a");
const TEXT = new Color("#2d2c2a");
const TEXT2 = new Color("#6b6860");
const TEXT3 = new Color("#a8a59e");
const BORDER = new Color("#e2dfd8");
const DANGER = new Color("#dc2626");
const PRIO_COLORS = [new Color("#ef4444"), new Color("#f97316"), new Color("#3b6fd4"), new Color("#9ca3af")];

// ─── FETCH DATA ───────────────────────────────────────────────
async function fetchData() {
  // Login
  const loginReq = new Request(`${APP_URL}/api/auth/login`);
  loginReq.method = "POST";
  loginReq.headers = { "Content-Type": "application/json" };
  loginReq.body = JSON.stringify({ email: EMAIL, password: PASSWORD });
  const loginResp = await loginReq.loadJSON();
  if (!loginResp.ok) throw new Error("Login failed");

  // Get cookie from response
  const cookie = loginReq.response?.headers?.["Set-Cookie"] || "";

  // Fetch tasks
  const tasksReq = new Request(`${APP_URL}/api/tasks`);
  tasksReq.headers = { Cookie: cookie };
  const tasks = await tasksReq.loadJSON();

  // Fetch habits
  const habitsReq = new Request(`${APP_URL}/api/habits`);
  habitsReq.headers = { Cookie: cookie };
  const habits = await habitsReq.loadJSON();

  return { tasks: Array.isArray(tasks) ? tasks : [], habits: Array.isArray(habits) ? habits : [], cookie };
}

function today() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

// ─── BUILD WIDGET ─────────────────────────────────────────────
async function buildWidget(size) {
  const widget = new ListWidget();
  widget.backgroundColor = BG;
  widget.setPadding(14, 14, 14, 14);
  widget.url = APP_URL;

  try {
    const { tasks, habits } = await fetchData();
    const t = today();

    // Today's tasks (due today or overdue, not done, no parent)
    const todayTasks = tasks
      .filter(tk => !tk.is_done && !tk.parent_id && (tk.due_date === t || tk.due_date < t || !tk.due_date))
      .sort((a, b) => (a.priority - b.priority));

    // Today's habits
    const habitsToday = habits.filter(h => !(h.log || {})[t]);
    const habitsDone = habits.filter(h => (h.log || {})[t]).length;

    // Header
    const header = widget.addStack();
    header.layoutHorizontally();
    header.centerAlignContent();

    const logoText = header.addText("Faheem");
    logoText.font = Font.lightSystemFont(13);
    logoText.textColor = TEXT2;
    const logoAccent = header.addText("Flow");
    logoAccent.font = Font.boldSystemFont(13);
    logoAccent.textColor = ACCENT;

    header.addSpacer();

    const dateText = header.addText(new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
    dateText.font = Font.systemFont(11);
    dateText.textColor = TEXT3;

    widget.addSpacer(8);

    if (size === "small") {
      // SMALL: just task count + habit progress
      const countStack = widget.addStack();
      countStack.layoutVertically();
      countStack.backgroundColor = SURFACE;
      countStack.cornerRadius = 10;
      countStack.setPadding(10, 12, 10, 12);

      const countNum = countStack.addText(String(todayTasks.length));
      countNum.font = Font.boldSystemFont(32);
      countNum.textColor = todayTasks.length > 0 ? ACCENT : GREEN;

      const countLbl = countStack.addText("tasks today");
      countLbl.font = Font.systemFont(12);
      countLbl.textColor = TEXT2;

      countStack.addSpacer(6);

      const habStack = countStack.addStack();
      habStack.layoutHorizontally();
      habStack.centerAlignContent();
      const habDot = habStack.addText("🌱");
      habDot.font = Font.systemFont(12);
      habStack.addSpacer(4);
      const habText = habStack.addText(`${habitsDone}/${habits.length} habits`);
      habText.font = Font.systemFont(11);
      habText.textColor = habitsDone === habits.length && habits.length > 0 ? GREEN : TEXT3;

    } else {
      // MEDIUM / LARGE: task list
      const maxTasks = size === "large" ? 8 : 4;
      const displayTasks = todayTasks.slice(0, maxTasks);

      if (displayTasks.length === 0) {
        const emptyStack = widget.addStack();
        emptyStack.layoutVertically();
        emptyStack.centerAlignContent();
        const emptyIcon = emptyStack.addText("✓");
        emptyIcon.font = Font.boldSystemFont(28);
        emptyIcon.textColor = new Color("#e2dfd8");
        emptyStack.addSpacer(4);
        const emptyText = emptyStack.addText("Nothing due today");
        emptyText.font = Font.systemFont(13);
        emptyText.textColor = TEXT3;
        emptyText.centerAlignText();
      } else {
        for (const tk of displayTasks) {
          const row = widget.addStack();
          row.layoutHorizontally();
          row.centerAlignContent();
          row.backgroundColor = SURFACE;
          row.cornerRadius = 7;
          row.setPadding(7, 10, 7, 10);

          // Priority dot
          const dot = row.addStack();
          dot.layoutVertically();
          dot.size = new Size(6, 6);
          dot.backgroundColor = PRIO_COLORS[(tk.priority || 4) - 1];
          dot.cornerRadius = 3;
          row.addSpacer(7);

          // Task name
          const nameText = row.addText(tk.name);
          nameText.font = Font.mediumSystemFont(13);
          nameText.textColor = TEXT;
          nameText.lineLimit = 1;

          row.addSpacer();

          // Overdue indicator
          if (tk.due_date && tk.due_date < t) {
            const ovText = row.addText("⚠");
            ovText.font = Font.systemFont(11);
            ovText.textColor = DANGER;
          }

          widget.addSpacer(4);
        }

        if (todayTasks.length > maxTasks) {
          const moreText = widget.addText(`+${todayTasks.length - maxTasks} more`);
          moreText.font = Font.systemFont(11);
          moreText.textColor = TEXT3;
          widget.addSpacer(4);
        }
      }

      // Habit summary at bottom
      widget.addSpacer();
      const habRow = widget.addStack();
      habRow.layoutHorizontally();
      habRow.centerAlignContent();
      habRow.backgroundColor = SURFACE;
      habRow.cornerRadius = 7;
      habRow.setPadding(6, 10, 6, 10);

      const habIcon = habRow.addText("🌱");
      habIcon.font = Font.systemFont(12);
      habRow.addSpacer(5);
      const habLabel = habRow.addText(`${habitsDone} of ${habits.length} habits done`);
      habLabel.font = Font.systemFont(12);
      habLabel.textColor = habitsDone === habits.length && habits.length > 0 ? GREEN : TEXT2;
      habRow.addSpacer();

      // Streak for first habit with active streak
      const bestStreak = Math.max(0, ...habits.map(h => {
        let s = 0, d = new Date(t + 'T12:00:00');
        while (s < 30) { const ds = d.toISOString().slice(0, 10); if ((h.log || {})[ds]) s++; else if (ds < t) break; d.setDate(d.getDate() - 1); }
        return s;
      }));
      if (bestStreak > 0) {
        const streakText = habRow.addText(`🔥 ${bestStreak}`);
        streakText.font = Font.boldSystemFont(12);
        streakText.textColor = ORANGE;
      }
    }

  } catch (e) {
    // Error state
    const errText = widget.addText("⚠ " + (e.message || "Could not load"));
    errText.font = Font.systemFont(13);
    errText.textColor = DANGER;
    errText.lineLimit = 2;
  }

  return widget;
}

// ─── RUN ─────────────────────────────────────────────────────
const widgetSize = config.widgetFamily || "medium";
const widget = await buildWidget(widgetSize);

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  // Preview in app
  widget.presentMedium();
}

Script.complete();
