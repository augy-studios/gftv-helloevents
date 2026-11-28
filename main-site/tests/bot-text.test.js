// The Telegram bot and the notices in each account's language
// (api/_lib/bot-text.js, migrations/029): every language file has the
// English keys and placeholders, the languages are the site's, and the
// builders write in the language they are given. No database and no
// network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SITE_URL = 'https://events.globalfurry.tv';
process.env.SUPABASE_URL = 'https://project.supabase.co';

const text = await import('../api/_lib/bot-text.js');
const msgs = await import('../api/_lib/telegram-messages.js');
const notify = await import('../api/_lib/notify.js');
const eventText = await import('../api/_lib/event-text.js');
const email = await import('../api/_lib/email.js');
const { registry } = await import('../assets/i18n/locales.js');

const PLURAL = /\.(zero|one|two|few|many|other)$/;
const base = (key) => key.replace(PLURAL, '');
const placeholders = (value) => [...new Set([...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort().join(',');

function event(over = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'sg-furmeet',
    title: 'SG Furmeet',
    status: 'published',
    publish_at: null,
    starts_at: '2032-08-06T10:00:00.000Z',
    ends_at: '2032-08-06T14:00:00.000Z',
    timezone: 'Asia/Singapore',
    dates_hidden: false,
    start_time_tbc: false,
    is_online: false,
    online_url: null,
    venue_name: 'Hall',
    venue_address: '1 Secret Road',
    city: 'Singapore',
    country: 'SG',
    cover_image_path: null,
    locations: [{ label: 'event', venue_name: 'Hall', venue_address: '1 Secret Road', city: 'Singapore', country: 'SG' }],
    meal_options: [{ id: 'dinner', label: null, limit: null, locations: [{ label: 'meal', venue_name: 'Lau Pa Sat' }] }],
    ...over,
  };
}

test('the bot speaks the site\'s languages, each with every English string and the same placeholders', () => {
  assert.deepEqual(text.BOT_LOCALES, registry.map((entry) => entry.code));
  const tables = text.allTables();
  const en = tables.en;
  const enBases = new Set(Object.keys(en).map(base));
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string', key);
    assert.notEqual(value, '', key);
  }
  for (const [code, table] of Object.entries(tables)) {
    const bases = new Set(Object.keys(table).map(base));
    for (const key of enBases) {
      assert.ok(bases.has(key), `${code} is missing ${key}`);
    }
    for (const key of bases) {
      assert.ok(enBases.has(key), `${code} has ${key}, which en.js does not`);
    }
    for (const [key, value] of Object.entries(table)) {
      assert.equal(typeof value, 'string', `${code} ${key}`);
      assert.notEqual(value, '', `${code} ${key}`);
      if (PLURAL.test(key)) {
        assert.ok(`${base(key)}.other` in table, `${code} ${base(key)} has no .other`);
      }
      // A plural's forms all carry the English .other's placeholders.
      let english = en[key];
      if (english === undefined) {
        english = en[`${base(key)}.other`];
      }
      assert.equal(placeholders(value), placeholders(english), `${code} ${key}`);
    }
  }
});

test('an account\'s language is one of the site\'s, English otherwise; a chat with none takes its Telegram app\'s', () => {
  assert.equal(text.botLocale('zh-SG'), 'zh-SG');
  assert.equal(text.botLocale('zh-sg'), 'zh-SG');
  assert.equal(text.botLocale(null), 'en');
  assert.equal(text.botLocale('fr'), 'en');
  assert.equal(text.knownLocale('fr'), null);
  assert.equal(text.localeFromTelegram('zh-hans'), 'zh-SG');
  assert.equal(text.localeFromTelegram('zh'), 'zh-SG');
  assert.equal(text.localeFromTelegram('ms'), 'ms');
  assert.equal(text.localeFromTelegram('ta'), 'ta');
  assert.equal(text.localeFromTelegram('en-GB'), 'en');
  assert.equal(text.localeFromTelegram('de'), 'en');
  assert.equal(text.localeFromTelegram(undefined), 'en');
});

test('plurals follow each language: Tamil has one and other, Chinese and Malay one form', () => {
  assert.equal(eventText.untilText(60_000), '1 minute');
  assert.equal(eventText.untilText(3 * 3_600_000), '3 hours');
  assert.equal(eventText.untilText(60_000, 'ta'), '1 நிமிடம்');
  assert.equal(eventText.untilText(5 * 60_000, 'ta'), '5 நிமிடங்கள்');
  assert.equal(eventText.untilText(2 * 86_400_000, 'zh-SG'), '2 天');
  assert.equal(eventText.untilText(7 * 86_400_000, 'ms'), '1 minggu');
  // A missing key falls back to English, then to the key.
  assert.equal(text.botT('ms', 'no.such-key'), 'no.such-key');
});

test('dates, times and countries are written the way the language writes them', () => {
  const row = event();
  assert.equal(eventText.startDateText(row), 'Fri, 6 Aug 2032');
  assert.match(eventText.startDateText(row, 'zh-SG'), /2032年8月6日/);
  assert.equal(eventText.countryText('SG', 'zh-SG'), '新加坡');
  assert.equal(eventText.countryText('SG', 'ms'), 'Singapura');
  assert.equal(eventText.countryText('Singapore', 'ta'), 'Singapore', 'typed before the list: as typed');
  assert.equal(eventText.whenText(event({ dates_hidden: true }), 'ms'), 'Tarikh akan diumumkan');
  assert.equal(eventText.placeText(event({ is_online: true }), 'zh-SG'), 'Hall, Singapore, 线上');
});

test('a sign-in code comes in the account\'s language, with the code and its escaping intact', () => {
  const zh = msgs.codeMessage({ purpose: 'sign-in', username: 'fox_tail', code: '123456', minutes: 5, locale: 'zh-SG' });
  assert.ok(zh.markdown.startsWith('## 登录验证码'));
  assert.ok(zh.markdown.includes('`123456`'));
  assert.ok(zh.markdown.includes('fox\\_tail'));
  assert.ok(zh.markdown.includes('| 账户 | fox\\_tail |'));
  assert.ok(zh.markdown.includes('| 有效期 | 5 分钟后失效 |'));
  assert.ok(zh.fallback.includes('验证码：123456'));
  assert.equal(zh.skipEntities, true);
  const reset = msgs.codeMessage({ purpose: 'reset', username: 'otter', code: '654321', minutes: 1, locale: 'ta' });
  assert.ok(reset.markdown.startsWith('## கடவுச்சொல் மீட்டமைப்புக் குறியீடு'));
  assert.ok(reset.fallback.includes('இது 1 நிமிடத்தில் காலாவதியாகும்.'));
  const english = msgs.codeMessage({ purpose: 'sign-in', username: 'otter', code: '111111', minutes: 5 });
  assert.ok(english.markdown.startsWith('## Sign-in code'));
  assert.ok(english.fallback.includes('It expires in 5 minutes.'));
});

test('the help says the same in every language, and that it follows the site\'s language', () => {
  for (const code of text.BOT_LOCALES) {
    const help = msgs.helpMessage(code);
    assert.ok(help.markdown.includes('events.globalfurry.tv'), code);
    assert.ok(help.markdown.includes('/unlink'), code);
    assert.ok(help.fallback.includes('/unlink'), code);
  }
  assert.ok(msgs.helpMessage('ms').markdown.includes('**Pautkan Telegram**'));
  assert.ok(msgs.helpMessage().markdown.includes('the language you use on events.globalfurry.tv'));
});

test('every kind of notice is written in the language it is built for, with the editors\' words as typed', () => {
  const row = event();
  const fresh = notify.noticeFor('new', row, 'zh-SG');
  assert.equal(fresh.heading, '新活动');
  assert.equal(fresh.locale, 'zh-SG');
  assert.deepEqual(fresh.details.map(([label]) => label), ['日期', '时间', '地点']);
  assert.equal(notify.noticeFor('cancelled', row, 'ms').intro, 'Acara ini tidak akan diadakan.');
  const eventMessage = msgs.eventNoticeMessage(notify.noticeFor('paid', row, 'ta'));
  assert.ok(eventMessage.markdown.startsWith('## கட்டணம் உறுதிசெய்யப்பட்டது\n\n**SG Furmeet**'));

  const reminder = notify.reminderNotice(row, ['dinner'], Date.parse('2032-08-06T09:00:00.000Z'), 'zh-SG');
  assert.equal(reminder.heading, '1 小时后开始');
  const markdown = reminder.rich.markdown;
  for (const part of ['## 1 小时后开始', '**SG Furmeet**', '|  | 详情 |', '| 参与方式 | 仅参加晚餐 |', '## 地点', '### 活动地点', '| 地址 | 1 Secret Road |',
    '| 国家/地区 | 新加坡 |', '## 你的聚餐', '### 晚餐', '| 场地 | Lau Pa Sat |']) {
    assert.ok(markdown.includes(part), `${part} in\n${markdown}`);
  }
  assert.equal(markdown.includes('Detail'), false);

  const going = notify.joinNotice(row, [], 'ms');
  assert.equal(going.heading, 'Anda akan hadir');
  assert.ok(going.rich.markdown.includes('| Hadir untuk | Keseluruhan acara |'));
  assert.ok(going.rich.fallback.includes('SESI MAKAN DI TEMPAT LAIN'));

  const moved = { ...row, locations: [...row.locations, { label: 'meeting', venue_name: 'Exit B', city: 'Singapore' }] };
  const update = notify.updateNotice(row, moved, 'ta');
  assert.equal(update.heading, 'சந்திப்பு இடம் சேர்க்கப்பட்டது');
  assert.deepEqual(update.lines, ['சந்திப்பு இடம் சேர்க்கப்பட்டது: Exit B, Singapore']);
  for (const part of ['## என்ன மாறியது', '|  | முன்பு | இப்போது |', '| நிகழ்விடம் | இல்லை | Exit B |', '## நிகழ்வு விவரங்கள்']) {
    assert.ok(update.rich.markdown.includes(part), `${part} in\n${update.rich.markdown}`);
  }
  const both = notify.updateNotice(row, { ...moved, starts_at: '2032-08-07T10:00:00.000Z' }, 'zh-SG');
  assert.equal(both.heading, '活动已更新');
  assert.match(both.lines[0], /^现改为 /);

  // English stays as it was.
  assert.equal(notify.reminderNotice(row, [], Date.parse('2032-08-06T09:00:00.000Z')).heading, 'Starting in 1 hour');
});

test('code emails and the reset notice come in the account\'s language, marked with it', () => {
  const link = 'https://events.globalfurry.tv/login?email=abc';
  const zh = email.codeEmail({ purpose: 'sign-in', username: 'otter', code: '123456', link, minutes: 10, locale: 'zh-SG' });
  assert.equal(zh.subject, '你的登录验证码：123456');
  assert.ok(zh.html.startsWith('<!doctype html><html lang="zh-SG">'));
  assert.ok(zh.html.includes('<h1 style="font-size:22px;margin:0 0 16px">登录验证码</h1>'));
  assert.ok(zh.text.includes('验证码：123456'));
  assert.ok(zh.text.includes(`登录：${link}`));
  assert.ok(zh.text.includes('两者均将在 10 分钟后失效。'));
  const confirm = email.codeEmail({ purpose: 'confirm', username: 'otter', code: '654321', link, minutes: 1, locale: 'ta' });
  assert.equal(confirm.subject, 'உங்கள் மின்னஞ்சல் முகவரியை உறுதிப்படுத்தவும்: 654321');
  assert.ok(confirm.text.includes('இரண்டும் 1 நிமிடத்தில் காலாவதியாகும்.'));
  const reset = email.resetNoticeEmail({ username: 'otter', locale: 'ms' });
  assert.equal(reset.subject, 'Kata laluan anda telah ditetapkan semula');
  assert.ok(reset.html.includes('lang="ms"'));
  // No language saved: English, as before.
  const english = email.codeEmail({ purpose: 'reset', username: 'otter', code: '111111', link, minutes: 10 });
  assert.equal(english.subject, 'Your password reset code: 111111');
  assert.ok(english.html.includes('lang="en"'));
  assert.ok(english.text.includes('The button works only in the browser where you asked for this email. On any other device, type the code. Both expire in 10 minutes.'));
  assert.equal(email.resetNoticeEmail({ username: 'otter' }).subject, 'Your password was reset');
});

test('a missing locale column is noticed, left out, and looked for again five minutes later', async (t) => {
  const column = await import('../api/_lib/locale-column.js');
  column.resetLocaleColumn();
  t.after(column.resetLocaleColumn);
  t.mock.method(console, 'warn', () => {});
  const missing = { data: null, error: { code: '42703', message: 'column gftvevents_accounts.locale does not exist' } };
  const tried = [];
  const query = (answer) => async (withLocale) => {
    tried.push(withLocale);
    if (withLocale) {
      return answer;
    }
    return { data: 'without', error: null };
  };
  const start = Date.parse('2032-08-06T10:00:00Z');
  assert.deepEqual(await column.withLocaleColumn(query(missing), start), { data: 'without', error: null });
  assert.deepEqual(tried, [true, false]);
  await column.withLocaleColumn(query(missing), start + 60_000);
  assert.deepEqual(tried, [true, false, false], 'not asked again for a while');
  const present = await column.withLocaleColumn(query({ data: 'with', error: null }), start + 5 * 60_000);
  assert.equal(present.data, 'with', 'there after the migration');
  // A write PostgREST refuses for the column counts too; other errors do not.
  assert.equal(column.missingLocaleColumn({ code: 'PGRST204', message: "Could not find the 'locale' column of 'gftvevents_accounts' in the schema cache" }), true);
  assert.equal(column.missingLocaleColumn({ code: '42703', message: 'column gftvevents_accounts.country does not exist' }), false);
  assert.equal(column.missingLocaleColumn({ code: '23505', message: 'duplicate key' }), false);
  const other = { data: null, error: { code: '23505', message: 'duplicate key' } };
  assert.equal(await column.withLocaleColumn(query(other), start + 6 * 60_000), other, 'passed back to throw as before');
});
