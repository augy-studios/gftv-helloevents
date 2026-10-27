// An in-memory stand-in for the supabase-js client, covering the query
// builder calls the API makes, with the schema's unique constraints, foreign
// key cascades, the generated last_at column and the RPC functions from
// migrations/001 and 002 (accounts; Storage for cover pictures). Adapted from gftv-linktree's tests/fake-db.js. Enough to
// drive the routes end to end in tests; not a general PostgREST.

import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();

const DEFAULTS = {
  gftvevents_accounts: () => ({
    staff_user_id: null, username: null, display_name: null, email: null, password_hash: null, terms_accepted_at: null,
    email_verified_at: null, password_changed_at: null, status: 'active', notify_updates: true, notify_reminders: true,
    notify_new_events: false, notify_telegram: false, updated_at: now(), last_sign_in_at: null,
  }),
  gftvhello_users: () => ({ is_admin: false, is_editor: false, is_approved: false, totp_secret: null, avatar_url: null }),
  gftvevents_sessions: () => ({ last_seen_at: now(), ip_hash: null }),
  gftvevents_auth_challenges: () => ({ attempts: 0, pending_totp_secret: null, telegram_code_hash: null, telegram_code_expires_at: null, pending_telegram_chat_id: null, pending_telegram_username: null }),
  gftvevents_passkeys: () => ({ counter: 0, transports: null, label: null, last_used_at: null }),
  gftvevents_backup_codes: () => ({ used: false, used_at: null }),
  gftvevents_telegram_link_tokens: () => ({ used_at: null, challenge_id: null }),
  gftvevents_events: () => ({
    kind: 'furmeet', summary: null, description: null, status: 'draft', publish_at: null, starts_at: null, ends_at: null,
    timezone: 'Asia/Singapore', dates_hidden: false, is_online: false, online_url: null, venue_name: null, venue_address: null,
    address_attendees_only: false, city: null, country: null, cover_image_url: null, external_url: null, organiser_name: null,
    price_type: 'free', price_min: null, price_max: null, currency: null, price_note: null, price_hidden: false,
    capacity: null, rsvp_open: true, staff_notes: null, created_by: null, updated_by: null, updated_at: now(),
    cover_image_url: null, cover_image_path: null, announced_at: null,
  }),
  gftvevents_audit_logs: () => ({ details: {}, actor_id: null, event_id: null, ip_hash: null }),
  gftvevents_password_resets: () => ({ used_at: null, created_by: null }),
  gftvevents_signup_allowances: () => ({ label: null, revoked_at: null, created_by: null }),
};

// Generated columns, recomputed on every write.
const COMPUTED = {
  gftvevents_events: (r) => { r.last_at = r.ends_at ?? r.starts_at ?? null; },
};

// A primary key other than id, as one column or several.
const PRIMARY = {
  gftvevents_rate_limits: 'bucket',
  gftvevents_totp_secrets: 'user_id',
  gftvevents_telegram_links: 'user_id',
  gftvevents_attendees: ['event_id', 'user_id'],
};
const UNIQUE = {
  gftvevents_accounts: ['username', 'email', 'staff_user_id'],
  gftvhello_users: ['username', 'email'],
  gftvevents_sessions: ['token_hash'],
  gftvevents_auth_challenges: ['token_hash'],
  gftvevents_passkeys: ['credential_id'],
  gftvevents_telegram_link_tokens: ['token_hash'],
  gftvevents_events: ['slug'],
  gftvevents_password_resets: ['code_hash'],
  gftvevents_name_filters: ['term'],
};

// Since migrations/002 every account reference points at gftvevents_accounts.
const toAccount = (column, onDelete = 'cascade') => ({ column, parent: 'gftvevents_accounts', onDelete });
// child table -> [{ column, parent, onDelete }]
const FKS = {
  gftvevents_accounts: [{ column: 'staff_user_id', parent: 'gftvhello_users', onDelete: 'cascade' }],
  gftvevents_sessions: [toAccount('user_id')],
  gftvevents_auth_challenges: [toAccount('user_id')],
  gftvevents_webauthn_challenges: [toAccount('user_id')],
  gftvevents_passkeys: [toAccount('user_id')],
  gftvevents_totp_secrets: [toAccount('user_id')],
  gftvevents_backup_codes: [toAccount('user_id')],
  gftvevents_telegram_links: [toAccount('user_id')],
  gftvevents_telegram_link_tokens: [toAccount('user_id'), { column: 'challenge_id', parent: 'gftvevents_auth_challenges', onDelete: 'cascade' }],
  gftvevents_attendees: [{ column: 'event_id', parent: 'gftvevents_events', onDelete: 'cascade' }, toAccount('user_id')],
  gftvevents_audit_logs: [toAccount('actor_id', 'set null'), { column: 'event_id', parent: 'gftvevents_events', onDelete: 'set null' }],
  gftvhello_backup_codes: [{ column: 'user_id', parent: 'gftvhello_users', onDelete: 'cascade' }],
  // migrations/003
  gftvevents_password_resets: [toAccount('account_id'), toAccount('created_by', 'set null')],
  gftvevents_signup_allowances: [toAccount('created_by', 'set null')],
  gftvevents_name_filters: [toAccount('created_by', 'set null')],
};


function splitTop(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function likeToRegex(pattern, flags) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, flags);
}

export function createFakeDb() {
  const tables = {};
  const table = (name) => (tables[name] ??= []);

  function project(name, row, select) {
    if (!select || select.trim() === '*') return { ...row };
    const out = {};
    for (const part of splitTop(select.replace(/\s+/g, ' '))) {
      const embed = part.match(/^(?:(\w+):)?(\w+)\s*\((.*)\)$/);
      if (embed) {
        const [, alias, target, inner] = embed;
        const key = alias || target;
        const up = (FKS[name] || []).find((fk) => fk.parent === target);
        if (up) {
          const parent = table(target).find((r) => r.id === row[up.column]);
          out[key] = parent ? project(target, parent, inner) : null;
        } else {
          const down = (FKS[target] || []).find((fk) => fk.parent === name);
          const children = down ? table(target).filter((r) => r[down.column] === row.id) : [];
          out[key] = inner.trim() === 'count' ? [{ count: children.length }] : children.map((c) => project(target, c, inner));
        }
      } else {
        out[part] = row[part] === undefined ? null : row[part];
      }
    }
    return out;
  }

  function cascade(name, removed) {
    for (const [child, fks] of Object.entries(FKS)) {
      for (const fk of fks) {
        if (fk.parent !== name) continue;
        const ids = new Set(removed.map((r) => r.id));
        if (fk.onDelete === 'cascade') {
          const gone = table(child).filter((r) => ids.has(r[fk.column]));
          tables[child] = table(child).filter((r) => !ids.has(r[fk.column]));
          cascade(child, gone);
        } else {
          for (const r of table(child)) if (ids.has(r[fk.column])) r[fk.column] = null;
        }
      }
    }
  }

  function violates(name, row, ignore) {
    for (const col of UNIQUE[name] || []) {
      if (row[col] === undefined || row[col] === null) continue;
      if (table(name).some((r) => r !== ignore && r[col] === row[col])) return true;
    }
    return false;
  }

  class Query {
    constructor(name) {
      this.name = name;
      this.filters = [];
      this.op = 'select';
      this.columns = '*';
      this.wantRows = true;
    }
    select(columns = '*', opts = {}) {
      if (this.op === 'select') {
        this.columns = columns;
        this.countMode = opts.count;
        this.head = opts.head;
      } else {
        this.returning = columns;
      }
      return this;
    }
    insert(values) { this.op = 'insert'; this.values = values; return this; }
    upsert(values) { this.op = 'upsert'; this.values = values; return this; }
    update(fields) { this.op = 'update'; this.fields = fields; return this; }
    delete(opts = {}) { this.op = 'delete'; this.countMode = opts.count; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
    lt(c, v) { this.filters.push((r) => r[c] !== null && r[c] !== undefined && r[c] < v); return this; }
    lte(c, v) { this.filters.push((r) => r[c] !== null && r[c] !== undefined && r[c] <= v); return this; }
    gt(c, v) { this.filters.push((r) => r[c] !== null && r[c] > v); return this; }
    gte(c, v) { this.filters.push((r) => r[c] !== null && r[c] >= v); return this; }
    is(c, v) { this.filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return this; }
    not(c, op, v) {
      if (op !== 'is' || v !== null) throw new Error(`fake not(${op}) unsupported`);
      this.filters.push((r) => r[c] !== null && r[c] !== undefined);
      return this;
    }
    in(c, values) { this.filters.push((r) => values.includes(r[c])); return this; }
    like(c, p) { const re = likeToRegex(p, ''); this.filters.push((r) => re.test(String(r[c] ?? ''))); return this; }
    ilike(c, p) { const re = likeToRegex(p, 'i'); this.filters.push((r) => re.test(String(r[c] ?? ''))); return this; }
    or(expr) {
      const clauses = expr.split(/,(?=\w+\.)/).map((part) => {
        const m = part.match(/^(\w+)\.(ilike|eq|is|lte|gte|lt|gt)\.(?:"(.*)"|(.*))$/);
        if (!m) throw new Error(`fake or() cannot parse ${part}`);
        const [, col, op] = m;
        const value = m[3] ?? m[4];
        if (op === 'is') return (r) => (value === 'null' ? r[col] === null || r[col] === undefined : String(r[col]) === value);
        if (op === 'ilike') { const re = likeToRegex(value, 'i'); return (r) => re.test(String(r[col] ?? '')); }
        const cmp = { lte: (a, b) => a <= b, gte: (a, b) => a >= b, lt: (a, b) => a < b, gt: (a, b) => a > b, eq: (a, b) => String(a) === b }[op];
        return (r) => r[col] !== null && r[col] !== undefined && cmp(r[col], value);
      });
      this.filters.push((r) => clauses.some((f) => f(r)));
      return this;
    }
    order(c, { ascending = true } = {}) { this.sort = { c, ascending }; return this; }
    range(from, to) { this.window = [from, to]; return this; }
    limit(n) { this.window = [0, n - 1]; return this; }
    maybeSingle() { this.single_ = 'maybe'; return this; }
    single() { this.single_ = 'one'; return this; }
    then(resolve, reject) {
      try { resolve(this.run()); } catch (e) { reject(e); }
    }
    matches() { return table(this.name).filter((r) => this.filters.every((f) => f(r))); }
    shape(rows, columns) {
      let out = rows.map((r) => project(this.name, r, columns));
      if (this.single_ === 'one') {
        if (out.length !== 1) return { data: null, error: { code: 'PGRST116', message: `expected one row, got ${out.length}` } };
        return { data: out[0], error: null };
      }
      if (this.single_ === 'maybe') {
        if (out.length > 1) return { data: null, error: { code: 'PGRST116', message: 'more than one row' } };
        return { data: out[0] ?? null, error: null };
      }
      return { data: out, error: null };
    }
    run() {
      const name = this.name;
      if (this.op === 'select') {
        let rows = this.matches();
        if (this.sort) {
          const { c, ascending } = this.sort;
          rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (ascending ? 1 : -1));
        }
        const count = rows.length;
        if (this.window) rows = rows.slice(this.window[0], this.window[1] + 1);
        if (this.head) return { data: null, error: null, count };
        return { ...this.shape(rows, this.columns), count: this.countMode ? count : null };
      }
      if (this.op === 'insert' || this.op === 'upsert') {
        const list = Array.isArray(this.values) ? this.values : [this.values];
        const made = [];
        for (const values of list) {
          const pk = PRIMARY[name] || 'id';
          if (this.op === 'upsert') {
            const existing = table(name).find((r) => [].concat(pk).every((c) => r[c] === values[c]));
            if (existing) { Object.assign(existing, values); COMPUTED[name]?.(existing); made.push(existing); continue; }
          }
          const row = { ...(DEFAULTS[name]?.() ?? {}), created_at: now(), ...values };
          if (pk === 'id' && !row.id) row.id = randomUUID();
          COMPUTED[name]?.(row);
          for (const fk of FKS[name] || []) {
            if (row[fk.column] && !table(fk.parent).some((p) => p.id === row[fk.column])) {
              return { data: null, error: { code: '23503', message: `fk ${fk.column}` } };
            }
          }
          if (violates(name, row)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          if (name === 'gftvevents_events' && !row.dates_hidden && !row.starts_at) return { data: null, error: { code: '23514', message: 'check' } };
          table(name).push(row);
          made.push(row);
        }
        if (this.returning === undefined) return { data: null, error: null };
        return this.shape(made, this.returning);
      }
      if (this.op === 'update') {
        const rows = this.matches();
        for (const r of rows) {
          const next = { ...r, ...this.fields };
          if (violates(name, next, r)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          Object.assign(r, this.fields);
          if ('updated_at' in r) r.updated_at = now();
          COMPUTED[name]?.(r);
        }
        if (this.returning === undefined) return { data: null, error: null };
        return this.shape(rows, this.returning);
      }
      if (this.op === 'delete') {
        const rows = this.matches();
        tables[name] = table(name).filter((r) => !rows.includes(r));
        cascade(name, rows);
        if (this.returning === undefined) return { data: null, error: null, count: this.countMode ? rows.length : null };
        return this.shape(rows, this.returning);
      }
      throw new Error(`fake op ${this.op}`);
    }
  }

  const rpcs = {
    gftvevents_rate_hit({ p_bucket, p_window_seconds }) {
      const t = table('gftvevents_rate_limits');
      let row = t.find((r) => r.bucket === p_bucket);
      const windowStart = Date.now() - p_window_seconds * 1000;
      if (!row) {
        row = { bucket: p_bucket, hits: 0, window_start: now() };
        t.push(row);
      }
      if (new Date(row.window_start).getTime() < windowStart) {
        row.hits = 0;
        row.window_start = now();
      }
      row.hits += 1;
      return row.hits;
    },
    // The same rules as the SQL function in migrations/001.
    gftvevents_rsvp({ p_event_id, p_user_id }) {
      const e = table('gftvevents_events').find((r) => r.id === p_event_id);
      if (!e) return 'not_found';
      if (!['published', 'cancelled'].includes(e.status) || (e.publish_at && e.publish_at > now())) return 'not_found';
      if (e.status === 'cancelled' || !e.rsvp_open) return 'rsvp_closed';
      if (e.last_at && e.last_at < now()) return 'event_over';
      const going = table('gftvevents_attendees').filter((r) => r.event_id === p_event_id);
      if (going.some((r) => r.user_id === p_user_id)) return 'already';
      if (e.capacity !== null && going.length >= e.capacity) return 'event_full';
      table('gftvevents_attendees').push({ event_id: p_event_id, user_id: p_user_id, created_at: now() });
      return 'ok';
    },
  };

  // Supabase Storage: upload and remove, kept in a map of "bucket/path".
  const objects = new Map();
  const storage = {
    from: (bucket) => ({
      async upload(path, body, opts = {}) {
        const key = `${bucket}/${path}`;
        if (objects.has(key) && !opts.upsert) return { data: null, error: { message: 'The resource already exists' } };
        objects.set(key, { body, contentType: opts.contentType });
        return { data: { path }, error: null };
      },
      async remove(paths) {
        paths.forEach((p) => objects.delete(`${bucket}/${p}`));
        return { data: paths.map((name) => ({ name })), error: null };
      },
    }),
  };

  return {
    objects,
    storage,
    tables,
    table,
    from: (name) => new Query(name),
    rpc: async (name, args) => {
      if (!rpcs[name]) return { data: null, error: { message: `no rpc ${name}` } };
      return { data: rpcs[name](args), error: null };
    },
  };
}
