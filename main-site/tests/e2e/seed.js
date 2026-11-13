// The fixture data every end-to-end test starts from. The e2e server
// (server.js) loads it into a fresh in-memory database before each test, and
// the specs import the names, passwords and codes from here, so the two can
// never drift apart.
//
// Dates are fixed, not relative to today, so what the pages show is the same
// on every run: the upcoming events are in 2032 (move them on before then),
// the past one is in 2025, and the browser's clock is frozen at FIXED_NOW
// (fixtures.js).
//
//   inkfox      a GFTV staff editor (gftvhello_users), with the shared
//               authenticator app secret staff sign in with
//   riverotter  a public account with no second step: the password is the
//               whole sign-in
//   keyfox      a public account with 2FA: two passkeys (one used, with a
//               last_used_at, one never used) and ten backup codes, going to
//               the furmeet
//
// Events: an upcoming furmeet (attendees-only address, 20 spaces), an
// upcoming convention (paid), a past meet, one with dates to come, and a
// draft that the public must never see.

import bcrypt from 'bcryptjs';

// The moment the browser thinks it is (Friday 13 November 2026, 10:00 in
// Singapore).
export const FIXED_NOW = '2026-11-13T02:00:00.000Z';
export const TIME_ZONE = 'Asia/Singapore';

// Every seeded account uses this password. Hashed with a low bcrypt cost so
// sign-in stays quick; bcrypt reads the cost from the hash.
export const PASSWORD = 'paws and whiskers 2032';

// Base32, as gftv.asia stores it in gftvhello_users.totp_secret.
export const STAFF_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export const STAFF = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'inkfox',
  displayName: 'Ink Fox',
  email: 'inkfox@example.org',
};

export const MEMBER = {
  id: '00000000-0000-4000-8000-000000000002',
  username: 'riverotter',
  displayName: 'River Otter',
  email: 'riverotter@example.org',
};

export const PASSKEY_MEMBER = {
  id: '00000000-0000-4000-8000-000000000003',
  username: 'keyfox',
  displayName: 'Key Fox',
  email: 'keyfox@example.org',
};

// keyfox's two passkeys. USED has a last_used_at, the line the account page
// shows as "Last used <date>"; UNUSED has none and shows "Never used".
export const PASSKEYS = {
  used: {
    id: '00000000-0000-4000-8000-0000000000a1',
    label: 'MacBook Touch ID',
    createdAt: '2026-09-01T03:00:00.000Z',
    lastUsedAt: '2026-11-10T06:30:00.000Z',
  },
  unused: {
    id: '00000000-0000-4000-8000-0000000000a2',
    label: 'YubiKey',
    createdAt: '2026-10-05T12:15:00.000Z',
    lastUsedAt: null,
  },
};

// keyfox's backup codes, as issued (crypto.js generateBackupCodes' shape).
export const BACKUP_CODES = Array.from({ length: 10 }, (unused, index) => `e2ekf-${String(index).padStart(5, '0')}`);

export const EVENTS = {
  furmeet: {
    id: '00000000-0000-4000-8000-0000000000e1',
    slug: 'marina-bay-furmeet',
    title: 'Marina Bay Furmeet',
    kind: 'furmeet',
    status: 'published',
    summary: 'An afternoon walk along the bay, then dinner.',
    description: 'Meet at the fountain. Bring water and a fan.',
    organiser_name: 'SG Furmeets',
    starts_at: '2032-03-13T06:00:00.000Z',
    ends_at: '2032-03-13T09:00:00.000Z',
    timezone: 'Asia/Singapore',
    venue_name: 'Marina Bay Sands Event Plaza',
    venue_address: '10 Bayfront Avenue',
    address_attendees_only: true,
    city: 'Singapore',
    country: 'Singapore',
    price_type: 'free',
    capacity: 20,
    rsvp_open: true,
    staff_notes: 'Permit number on file.',
  },
  convention: {
    id: '00000000-0000-4000-8000-0000000000e2',
    slug: 'lion-city-furcon-2032',
    title: 'Lion City Furcon 2032',
    kind: 'convention',
    status: 'published',
    summary: 'Three days of panels, a dealers den and a dance.',
    starts_at: '2032-08-06T02:00:00.000Z',
    ends_at: '2032-08-08T10:00:00.000Z',
    timezone: 'Asia/Singapore',
    venue_name: 'Suntec Convention Centre',
    city: 'Singapore',
    country: 'Singapore',
    price_type: 'paid',
    price_min: 45,
    price_max: 120,
    currency: 'SGD',
    rsvp_open: true,
  },
  past: {
    id: '00000000-0000-4000-8000-0000000000e3',
    slug: 'sunset-picnic-meet',
    title: 'Sunset Picnic Meet',
    kind: 'furmeet',
    status: 'published',
    starts_at: '2025-05-10T10:00:00.000Z',
    ends_at: '2025-05-10T13:00:00.000Z',
    timezone: 'Asia/Singapore',
    venue_name: 'East Coast Park',
    city: 'Singapore',
    country: 'Singapore',
    price_type: 'free',
  },
  tba: {
    id: '00000000-0000-4000-8000-0000000000e4',
    slug: 'online-game-night',
    title: 'Online Game Night',
    kind: 'other',
    status: 'published',
    dates_hidden: true,
    is_online: true,
    online_url: 'https://meet.example.org/game-night',
    price_type: 'free',
  },
  draft: {
    id: '00000000-0000-4000-8000-0000000000e5',
    slug: 'secret-planning-meet',
    title: 'Secret Planning Meet',
    kind: 'furmeet',
    status: 'draft',
    starts_at: '2032-04-01T04:00:00.000Z',
    timezone: 'Asia/Singapore',
    price_type: 'free',
  },
};

// Fills a fresh database (tests/fake-db.js) with the accounts and events
// above. Inserts go through the fake's query builder, so its defaults,
// unique checks and foreign keys apply as they do in the unit tests.
export async function seedDatabase(db) {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const insert = async (table, rows) => {
    const { error } = await db.from(table).insert(rows);
    if (error) {
      throw new Error(`seed ${table}: ${error.message}`);
    }
  };

  await insert('gftvhello_users', {
    id: STAFF.id,
    username: STAFF.username,
    display_name: STAFF.displayName,
    email: STAFF.email,
    password_hash: passwordHash,
    is_approved: true,
    is_editor: true,
    is_admin: false,
    totp_secret: STAFF_TOTP_SECRET,
  });

  const accepted = '2026-08-01T00:00:00.000Z';
  for (const person of [MEMBER, PASSKEY_MEMBER]) {
    await insert('gftvevents_accounts', {
      id: person.id,
      kind: 'public',
      username: person.username,
      display_name: person.displayName,
      email: person.email,
      password_hash: passwordHash,
      terms_accepted_at: accepted,
      password_changed_at: accepted,
      created_at: accepted,
    });
  }

  for (const [index, passkey] of [PASSKEYS.used, PASSKEYS.unused].entries()) {
    let counter = 0;
    if (passkey.lastUsedAt) {
      counter = 3;
    }
    await insert('gftvevents_passkeys', {
      id: passkey.id,
      user_id: PASSKEY_MEMBER.id,
      credential_id: `e2e-credential-${index + 1}`,
      public_key: 'e2e-not-a-real-public-key',
      counter,
      transports: ['internal'],
      label: passkey.label,
      created_at: passkey.createdAt,
      last_used_at: passkey.lastUsedAt,
    });
  }

  // Stored the way factors.js issueBackupCodes stores them: bcrypt of the
  // normalised code (lowercase letters and digits only).
  const codeRows = [];
  for (const code of BACKUP_CODES) {
    const normalised = code.toLowerCase().replace(/[^a-z0-9]/g, '');
    codeRows.push({ user_id: PASSKEY_MEMBER.id, code_hash: await bcrypt.hash(normalised, 4) });
  }
  await insert('gftvevents_backup_codes', codeRows);

  const created = '2026-10-01T00:00:00.000Z';
  for (const event of Object.values(EVENTS)) {
    await insert('gftvevents_events', { ...event, created_at: created });
  }

  await insert('gftvevents_attendees', {
    event_id: EVENTS.furmeet.id,
    user_id: PASSKEY_MEMBER.id,
    created_at: '2026-11-01T08:00:00.000Z',
  });
}
