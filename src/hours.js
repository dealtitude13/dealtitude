/* ---------------------------------------------------------------------------
 * Opening hours: seven rows in, one readable line out.
 *
 * The line is what nearly every screen wants — a shop card, a list, an email —
 * and building it in one place means no screen has to parse prose to get it.
 * It is stored on shops.hours so a reader that only wants the line does not
 * have to fetch and group seven rows to print it.
 *
 * Display order starts on Monday, because that is how opening hours are read
 * on a door, while dow keeps 0 = Sunday to match JavaScript's getDay(). Those
 * two facts disagreeing is exactly the sort of thing that silently shifts a
 * whole week by one, so the conversion lives here and nowhere else.
 * ------------------------------------------------------------------------- */

const DOW_DISPLAY = [1, 2, 3, 4, 5, 6, 0];          // Mon … Sun
const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "09:00" or "09:00:00" -> "9:00 AM". Returns "" for anything unparseable. */
export function prettyTime(t) {
  if (!t) return "";
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "";
  let h = Number(m[1]);
  const mins = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${mins} ${ampm}`;
}

/* Two days print as one entry when they say the same thing, so a shop open the
   same hours all week reads as one phrase rather than seven. */
const same = (a, b) =>
  Boolean(a) && Boolean(b) && a.closed === b.closed
  && String(a.opens || "") === String(b.opens || "")
  && String(a.closes || "") === String(b.closes || "");

/**
 * Build the one-line summary. Returns "" when there is nothing to say, which
 * the caller should treat as "leave whatever prose is already there alone"
 * rather than as "this shop never opens".
 */
export function summarise(rows) {
  if (!Array.isArray(rows) || !rows.length) return "";
  const by = new Map(rows.map((r) => [Number(r.dow), r]));
  const week = DOW_DISPLAY.map((d) => by.get(d)).filter(Boolean);
  if (!week.length) return "";

  /* Every day the same, and open: the common case, and it deserves the
     shortest possible sentence. */
  if (week.length === 7 && week.every((r) => same(r, week[0]))) {
    return week[0].closed
      ? "Closed every day"
      : `Every day, ${prettyTime(week[0].opens)} – ${prettyTime(week[0].closes)}`;
  }

  /* Runs of consecutive days that agree. Only consecutive ones: "Mon, Wed,
     Fri" collapsing to "Mon–Fri" would be a lie, and it is the kind of lie
     somebody drives across town on. */
  const runs = [];
  for (const d of DOW_DISPLAY) {
    const r = by.get(d);
    if (!r) { runs.push(null); continue; }          // a day with nothing said
    const last = runs.at(-1);
    if (last && same(last.row, r)) last.days.push(d);
    else runs.push({ row: r, days: [d] });
  }

  /* A dash from two days up: the weekend is the commonest split of all, and
     "Sat–Sun" is how a shop writes it on its own door. "Sat, Sun" is not
     wrong, only clumsier, and this phrase is read far more often than most. */
  const label = (days) => days.length >= 2
    ? `${NAMES[days[0]]}–${NAMES[days.at(-1)]}`
    : NAMES[days[0]];

  return runs.filter(Boolean).map(({ row, days }) => row.closed
    ? `Closed ${label(days)}`
    : `${label(days)} ${prettyTime(row.opens)} – ${prettyTime(row.closes)}`
  ).join(" · ");
}

/**
 * What to say about right now. `now` is passed in rather than read from the
 * clock so this can be tested, and so a caller that already knows the shop's
 * local day does not get the server's.
 *
 * Returns null when this shop has said nothing about today, so the caller can
 * fall back to the prose line instead of printing a blank.
 */
export function today(rows, now = new Date()) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const r = rows.find((x) => Number(x.dow) === now.getDay());
  if (!r) return null;
  if (r.closed) return { closed: true, text: "Closed today" };
  return {
    closed: false,
    opens: r.opens, closes: r.closes,
    text: `Open today ${prettyTime(r.opens)} – ${prettyTime(r.closes)}`,
  };
}
