// gftvevents_accounts.locale (migrations/029) may not exist yet: the code can
// go out before the migration has run. Every query that reads or writes it
// goes through here, so until it exists sign-in, sessions and notices carry
// on without it (in English) instead of failing.
//
// The first query that finds the column missing logs it once and the next
// ones leave it out; it is looked for again every RECHECK_MS, so the bot
// starts speaking each account's language soon after the migration runs,
// with no redeploy.

const RECHECK_MS = 5 * 60_000;
let missingSince = 0;

// Whether a database error says the locale column is not there: Postgres's
// undefined_column (42703) for a select, PostgREST's PGRST204 (a column
// not in its schema cache) for an insert or update.
export function missingLocaleColumn(error) {
  if (!error || (error.code !== '42703' && error.code !== 'PGRST204')) {
    return false;
  }
  return /\blocale\b/.test(String(error.message));
}

function columnExpected(now) {
  if (missingSince === 0) {
    return true;
  }
  return now - missingSince >= RECHECK_MS;
}

function noteMissing(now) {
  if (missingSince === 0) {
    console.warn('[helloevents] gftvevents_accounts.locale is missing: run migrations/029_account_locale.sql. Until then everything is sent in English.');
  }
  missingSince = now;
}

// The result of run(withLocale), a supabase-js query ({ data, error }):
// run(true) reads or writes the locale column, run(false) leaves it out.
// run(true) is tried while the column is expected; when it turns out to be
// missing, run(false) answers instead.
export async function withLocaleColumn(run, now = Date.now()) {
  if (columnExpected(now)) {
    const result = await run(true);
    if (!missingLocaleColumn(result.error)) {
      if (!result.error) {
        missingSince = 0;
      }
      return result;
    }
    noteMissing(now);
  }
  return run(false);
}

// ", locale" when the column is to be read, '' when not: for select lists.
export function localeSelect(withLocale) {
  if (withLocale) {
    return ', locale';
  }
  return '';
}

// For tests: forget what was found.
export function resetLocaleColumn() {
  missingSince = 0;
}
