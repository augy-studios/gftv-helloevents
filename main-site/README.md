# GFTV HelloEvents

events.globalfurry.tv: furmeets and furry conventions, with RSVP and notifications.

Static HTML, CSS and vanilla JavaScript with no build step, plus Node.js serverless functions in
`api/` on Vercel. Data lives in Supabase (the same project as `gftvhello_users`), reached only from
the functions with the service role key. No Supabase Auth, no request signing.

## How it fits together

- **Two kinds of account**, both rows in `gftvevents_accounts` (migrations/002):
  - **Staff**: the shared `gftvhello_users` accounts, read only here. Sign-in always needs a
    second factor; a staff account with none is told to set an authenticator up on gftv.asia
    first, as OneLink GFTV does. The gftv.asia authenticator and shared backup codes work here.
    Passkeys and Telegram can be added here afterwards. Passwords are reset on gftv.asia.
  - **Public**: anyone can sign up at `/signup` (username, display name, email, password, agreeing
    to the Terms of Use and Privacy Policy) to RSVP and get notifications. Passwords are bcrypt,
    cost 12. 2FA is optional: an authenticator app or a passkey switches it on, comes with ten
    backup codes, and then Telegram codes and backup codes are accepted too. No email is ever sent
    (emails are only for signing in and are not verified). A forgotten password is reset at
    `/reset` in one of three ways: a code sent to the linked Telegram chat (plus the second factor
    when 2FA is on), one backup code (when 2FA is on), or a one-time code an admin makes in
    `/manage` for a member with neither, after checking who they are. A staff code on an account
    with 2FA only sets the password; signing in still needs the second step.
  - **Names**: usernames and display names may not contain words that look like the team (staff,
    official, admin, GFTV, moderator, ...), compared after folding case, spacing, accents,
    look-alike Cyrillic and Greek letters and numbers used as letters. Admins add their own words
    in `/manage`; names that already match are listed there for follow-up, not changed.
- **Who can do what.** Any signed-in account can RSVP. Staff with `is_editor` or `is_admin` (and
  `is_approved`) manage events at `/manage`; only `is_admin` deletes. Roles are re-checked on every
  request. Anything set up on this site lives in `gftvevents_` tables; nothing is written to
  `gftvhello_users`.
- **Sessions** are an HttpOnly, Secure, SameSite=Strict `__Host-` cookie lasting 7 days; only its
  SHA-256 is stored. Cross-site writes are refused by an Origin check plus a JSON-only body.
- **Data minimisation**: every API answer is built field by field in `api/_lib/serialize.js`.
  Drafts and events with a future release time never reach the public; hidden prices and dates
  "to be announced" go out without the stored values; attendees-only addresses and online links go
  only to people going and to editors; staff notes and attendee lists go only to editors, and an
  attendee is a name, a username and staff or not, never an email. Each answer carries only what
  its page shows, plus the ids its buttons need (help desk #18); `tests/response-keys.test.js`
  pins every answer's exact fields, so one can't creep back in. `npm test` checks this.
- **Password reset** gives the same answer for an unknown, suspended or staff-only name, so it
  doesn't reveal which accounts exist; staff are pointed to gftv.asia.
- **Venue sign-ups.** New accounts are limited to 5 an hour per connection. At a meet or con where
  everyone shares the venue's Wi-Fi, a staff member opens `/manage` on that Wi-Fi and raises the
  limit for that connection (its salted IP hash) for 2 to 12 hours, to 50 to 500 an hour. It ends
  by itself or with "End now", and is in the audit log.
- **Gallery and cover pictures** (migrations/019). Every event has a gallery on `/manage`: "Add
  pictures" (several at once) or a picture pasted anywhere in the open form (Ctrl+V, Cmd+V on a
  Mac; pasted into a text field along with text, the text is pasted instead) adds pictures, up to
  100. Gallery pictures are never cropped: the browser only shrinks each to at most 2000 px on its
  longer side and compresses it to a WebP of at most 1 MB (`js/gallery-upload.js`), and the server
  checks it really is a still WebP within the limits (at least 320 px on its longer side and 100 on
  its shorter one), re-encodes it (stripping metadata) and stores it in the public-read Supabase
  Storage bucket `gftvevents_covers`, with a row in `gftvevents_event_images`. The event page shows
  them in columns, each in its own shape, under "About this event"; each opens larger in a dialog
  with Previous and Next (`js/event-gallery.js`). A picture is removed with its bin button, which
  asks once more first.
  The cover is cut from a gallery picture: only "Use as cover" on one opens the crop dialog
  (`js/cover-crop.js`), with a frame the shape of the cards' 16:9 thumbnail, starting on the
  middle of the picture, with the strips the wider 21:9 banner on the event page leaves out shaded
  and edged with dashed lines; the editor drags and zooms (slider, wheel, pinch or keyboard) to pick
  the part to show. The browser converts the part kept to a compressed 16:9 WebP (at most 1600 px
  wide and 1 MB), which the server checks and re-encodes the same way and stores as the cover,
  also the cards' thumbnail. The event remembers which gallery picture and crop the cover came
  from (`cover_source_image_id`, `cover_crop`), so that picture is marked "Cover" and "Adjust
  crop" starts from the earlier crop in any later visit. Taking that picture out of the gallery
  keeps the cover and forgets its source. The old cover is deleted when it is replaced; the cover
  and every gallery file are deleted with the event.
- **Pictures come from this site.** Pages never get a Supabase Storage address (a gallery picture
  is served the same way by `api/events/gallery-image.js`, with the same rules): a cover is
  served by `api/events/cover.js` (`/api/events/cover?slug=...&v=<cover name>`), as stored. A
  released event's cover is public and cached by the CDN for a year (a new upload gets a new
  address); an unreleased event's goes only to editors, never cached; anything else is a 404. A
  staff member's profile picture from gftv.asia is served by `api/me/avatar.js`, and only
  fetched when it is in this site's Supabase project. The Content-Security-Policy no longer
  allows images from Supabase at all.
- **Rich text descriptions** (migrations/020). Both descriptions are written in a Word-like editor
  on `/manage` (`js/rich-editor.js`): undo and redo; paragraph style (normal, three heading levels,
  quote); font; size in points; bold, italic, underline, strikethrough, subscript, superscript;
  text colour and highlight, each with "Automatic"; clear formatting; alignment; bullets and
  numbering; indent; links (Ctrl+K); pictures and stickers; tables with row and column tools;
  horizontal lines. Text pasted from Word, Google Docs or a web page keeps its formatting:
  `js/rich-text.js` maps it onto what a description can hold (Word's numbered paragraphs become
  real lists, Google Docs' bold spans become bold, and so on). So a description stays readable
  in dark mode, near-black and near-white text colours and near-white page backgrounds are left
  out (the text follows the theme), and highlighted text gets a colour readable on its highlight;
  colours chosen on purpose are kept. Pasted pictures are copied into the event's gallery and land
  where they were: one from another website is fetched by the server
  (`api/_lib/fetch-picture.js`: http(s) only, no private or internal addresses, checked when
  connecting, at most 3 redirects, 15 MB and 12 seconds), one pasted as a file or data by the
  browser; a picture only on the editor's own computer (Word's `file:` pictures) is left out, and
  the editor is told. The server cleans every description with the same rules before it is
  stored (`api/_lib/rich-text.js`, htmlparser2): only that short list of elements, attributes
  and style properties survives, links are http(s), mailto or tel only, and pictures are kept as
  references (`data-gallery-id`, `data-sticker-id`) that become this site's own addresses when a
  page asks; a picture taken out of the gallery disappears from the description with it. Pictures
  and stickers sit in line with the text, as in Word. Clicking a gallery picture in the editor (or
  Enter with one selected) opens a size and crop dialog (`js/picture-crop.js`): its size in the
  description (its own, or small, medium, large or full width: 25, 50, 75 or 100% of the text's
  width, `data-size`), and a frame over the whole picture, moved and resized by mouse, touch or
  keyboard, free or held to a shape (the picture's own, square, 4:3, 3:4, 16:9, 9:16); "Apply
  without a crop" takes the crop off, and undo takes a change back. The size and crop belong to that place in the
  description (`data-crop` is fractions of the picture); the gallery keeps the whole picture, and
  `api/events/gallery-image.js` serves the cropped part for an address carrying the crop. Plain
  text descriptions from before are read as paragraphs. Limits: 20000 characters of text, 100000
  of HTML, 100 pictures per description. The Content-Security-Policy allows inline style
  attributes (`style-src-attr 'unsafe-inline'`, nothing else) for the formatting; pages also
  apply it through the CSS object model for browsers without that directive.
- **Emoji, up to the latest edition** (Emoji 18.0 now). Descriptions keep every emoji as text,
  exactly (skin tones, zero-width-joiner sequences, keycaps, flags, the tag-sequence flags), and
  the editor's toolbar has an emoji picker (`js/emoji-picker.js`): every emoji of Unicode's
  latest edition by group, a search by name, a skin tone, and the ones used lately first,
  remembered in the browser. Everywhere on the site (titles, summaries, cards, every page), readers
  see their own device's emoji; any their device is too old to
  have come from the site's own copy of Google's Noto Color Emoji ("GFTV Emoji",
  `assets/fonts/emoji/`, SIL Open Font License 1.1 in `OFL.txt`), split into slices that load only
  when a page shows an emoji in their range. The font list is the `--emoji-fonts` variable in
  `style.css`, used after the site's font on every element, and kept after any font pasted into a
  description. When
  Unicode publishes a new edition (each September) and Noto has caught up, run
  `node tools/make-emoji.mjs` and bump `sw.js`'s VERSION: it rebuilds `assets/emoji/emoji.json`
  from Unicode's `emoji-test.txt` and the font slices from Google Fonts.
- **Telegram sticker packs** (migrations/020). Anyone who edits events can add Telegram sticker
  packs to their account, from a `t.me/addstickers/<name>` link, in the editor's picture dialog
  or the Sticker packs section of `/account`, and put the stickers in descriptions. The server
  reads the pack with the Bot API (`TELEGRAM_BOT_TOKEN`; the webhook settings are not needed for
  this) and copies each sticker into the private `gftvevents_stickers` bucket
  (`api/_lib/stickers.js`): still stickers as the WebP Telegram keeps them in, video stickers as
  WebM with a still WebP for Safari (which cannot play WebM with transparency). That still is
  Telegram's own small preview at first; the editor's browser (Chrome, Edge or Firefox) then draws
  each video's first frame at full size and sends it back (`js/sticker-packs.js`), whenever the
  packs are loaded. Animated (Lottie) stickers are left out. At most 30 packs per account and
  200 stickers per pack. Stickers are served by `api/stickers/image.js`, public and cached, since
  they are copies of public stickers in public descriptions. Deleting the account deletes its
  sticker files too. To check adding a pack against the real Bot API (everything else in memory,
  nothing written anywhere real), run
  `TELEGRAM_BOT_TOKEN=... node tests/live/telegram-stickers.js [pack link]`. Removing a pack deletes its files,
  and its stickers disappear from descriptions.
- **Managing events** at `/manage`: the event list and the edit form are separate tabs (Event list,
  Manage event). The form saves itself whenever a field is left, a list option picked or a box
  ticked; a pill at the bottom says "Saving…", "All changes saved" or why a change was refused.
  A new event is created once it has a title, both descriptions and a start date. The open event
  is kept in the address (`/manage?slug=...#editor`), so a reload reopens it. The form's sections
  are tabs of their own, stuck under the page header while it scrolls: Basics, When and where,
  Price and RSVP, Meals, and Attendees and notes. When a change is refused, the tab holding the
  field is marked with a dot. Delete (admins only) asks first, and offers "Set to Cancelled
  instead", which keeps the event and its RSVP list and tells the people going.
- **Event links.** The form's "Event link" field is the event's address (`/e/<link>`), made from
  the title when left blank. A typed link is tidied (lowercase, hyphens) and checked
  (`GET /api/manage/events?checkSlug=`) before it is saved; one another event has is not saved,
  and the form offers to add eight random characters to its end or to edit it again.
- **Ticket tiers** (migrations/008). A paid event can sell tickets in tiers: each has a name, a
  price and benefits (one per line). From the second tier on, ticking "Includes everything in
  <previous tier>" (off for a new tier) makes a tier include everything in the tier before it, and the event page either lists those benefits again in full or says
  "Everything in <tier>, plus:". The From and Up to prices then come from the tiers. A hidden
  price hides the tier prices too. Fields in a tier card save when the card is left.
- **Coming just for a meal** (migrations/007). In the edit form's "Coming just for a meal"
  section an editor ticks breakfast, lunch or dinner, and names up to five more ("High tea"). With
  any on, a signed-in person on the event page picks "The whole event" or "I only want to show
  up for the meal" and ticks one or more of the meals; while going they can change it, and it
  saves at once. Meal-only attendees see what attendees see, but take none of the event's spaces
  ("N going", the capacity and "Full" count only people coming to the whole event, through the
  `gftvevents_full_attendees` view, migrations/009). Instead each meal can have its own number of
  places; the event page shows the places left ("Lunch (6 places left)", "Dinner (full)"), and a
  full event still takes people just for a meal while one has room. The attendee list on
  `/manage` says who is coming for which meals, with a count per meal ("Lunch 3 of 10"). Once
  RSVPs close (migrations/010), nobody new joins, but someone going can still change their
  meals, within each meal's places, or go from the whole event to just meals; not the other way,
  which would take a space. A cancelled or finished event takes no changes. A
  meal the editor stops offering drops out of everyone's choice (kept in the database, so ticking
  it again brings it back); someone left with none counts as coming to the whole event.
- **A meal held somewhere else.** Under each meal offered, "Held somewhere else" opens up to three
  location cards like the ones in "Where" (a Google Maps link fills them in), each labelled as the
  meal's location, the meeting location, or the editor's own label: dinner at a restaurant after
  the meet, with a meeting point to walk over from. They are kept in that meal's entry in
  `meal_options` as `locations` (the same shape as the event's own, migrations/004), so no
  migration is needed; none means the meal is at the event's place, and unticking the box saves
  none. The event page lists them under "Where" after the event's own places, headed with the
  meal's name ("Dinner", "Dinner · Meeting location"). "Show the street addresses and map links
  only to people going" covers them too. Moving a meal's place, or bringing it back to the event,
  tells the people going, like any change of place.
- **RSVP IDs** (migrations/013). Everyone who RSVPs to an event, of any kind and whether for the
  whole event or just a meal, gets an ID counting up from 1 for that event: the first person going
  is #1, the next #2. Numbers are never reused (`gftvevents_rsvp_counters` keeps the last one
  handed out): if #3 takes back their RSVP, the next person still gets a new number, and someone
  who RSVPs again gets a new one too. Changing meals keeps it. The person sees "Your RSVP ID: #12"
  on the event page and "RSVP #12" on their My events cards; editors see each attendee's number
  in the attendee list. Nobody else sees any.
- **Volunteers** (migrations/012). Only a convention takes them. Under Price and RSVP, the edit
  form's Volunteers section has "Taking volunteers": with it on, someone signed in ticks "I
  would like to volunteer at this convention" on the event page when they RSVP, and while going
  can change it (it saves at once) until the event is over. Signing up is not volunteering: in
  the attendee list on `/manage` an editor ticks **Volunteered** next to the people who really did
  (kept in `gftvevents_volunteers`, with who ticked it); a count reads "Volunteers: 4 signed up ·
  2 volunteered". A later convention can then give those people a benefit: tick "Give a benefit
  to the people who volunteered at an earlier convention", pick that convention (every other
  convention is listed, latest first), and set a percentage (up to 100) or an amount in the
  event's currency. The event page shows the offer to everyone ("Volunteered at Mega Con 2025?
  You get 20% off."), and each confirmed volunteer of that convention sees "You volunteered at
  Mega Con 2025, so you get 20% off here."; the attendee list marks who "Gets the volunteer
  benefit". Nothing is taken off a price yet: applying it (discount codes) comes later. Whether
  someone signed up or volunteered goes only to them and to editors. An editor removing someone
  from the attendee list also removes their Volunteered tick; someone taking back their own RSVP
  after the convention keeps it, since they did volunteer.
- **Timetables and itineraries** (migrations/014). Any event can carry one, filled in under the
  edit form's Timetable tab, and the editor picks how the event page shows it:
  - **An itinerary** (the "timeline" view): a line down the side with a dot at each time of day
    and what happens then ("12:00: Travel to the border"). A step has a time only, no end or
    room, and counts as going on until the next step's time. The section is headed "Itinerary".
  - **A timetable** (the "grid" view): rooms (a name and a short tag such as "Level G", in
    column order) and items with a day, start, optional end (earlier than the start: the next
    day) and room. Visitors switch between a **table** (one day at a time, a column per room
    used that day, a row per half hour, like a con's printed schedule) and a **list**; the
    choice is kept in their browser, and a phone starts on the list.

  Both mark what is on now (highlighted, "Now"), fade what is over and mark what is next; the
  table draws a line at the current time and opens scrolled to it. Days and times are wall-clock
  in the event's zone, as typed, so the timetable stays put if the zone changes. An item or room
  card saves once it is left, like a ticket tier. While Itinerary is picked, the rooms and each
  item's end and room are hidden but kept. The event page shows it to everyone who can see the
  event, except while the dates are to be announced. A change people can see (not switching
  between the two views) tells the people going, batched like a change of time or place.
- **The event's link** (migrations/015). The edit form's Link is a button on the event page, and
  the editor picks what it says: Tickets and website, Tickets, Website, Join the group, Register,
  or their own words (up to 40 characters; until they are typed it says "Tickets and website").
- **Cross-border events** (migrations/015). An event held outside Singapore, or drawing people
  from other countries, is ticked "Cross-border event" under Basics; setting Kind to Convention
  ticks it (the editor can untick it), and the conventions already there were marked by the
  migration. It shows a "Cross-border" chip. Every account has a **country of origin** (Singapore,
  Malaysia and Indonesia first, then every other country): new public accounts pick it at sign-up,
  and anyone, staff included, sets or changes it in the account page's Profile tab, which is marked
  while it is missing. On a cross-border event:
  - an RSVP needs a country of origin. Without one the page says so, with a "Set my country"
    button that goes to the Profile tab and comes back to the event once it is saved. Someone
    already going (from before the event was made cross-border) can still change or cancel;
  - the link needs one too. Signed out, the button signs in first; signed in with no country, it
    goes to set one. The server leaves the link's address out of the answer until then. Editors
    always get it;
  - editors see each attendee's country (or "Country not given") in the attendee list, with a
    count per country ("From: Singapore 40 · Malaysia 12"). Nobody else sees anyone's country, and
    no other event sends it.
- **Checkout and payment methods** (migrations/016). Under Price and RSVP, a paid event's Payment
  section ticks any of: **Pay on the day** (a plain RSVP, no payment page), **Payment link** (the
  editor pastes it) and **QR code** (the editor uploads a picture, any shape, uncropped; kept as a
  lossless PNG up to 1200 px so it still scans). With a link or QR code ready, the event page's
  RSVP button becomes **Get a ticket**, which opens `/checkout?slug=...`: one ticket for the whole
  event, for the person signed in (a tier, when the event sells tiers), any volunteer benefit taken
  off, the way to pay, and the order. Reserving by link or QR code takes one of the event's spaces
  at once (no expiry) and shows the link or QR code (only then: neither goes to anyone else) and
  the organiser's instructions. The person then reports a payment reference and, if they like, a
  screenshot (WebP, at most 1600 px), and can report again or pay another way until it is
  confirmed. Editors see each attendee's tier, amount, method, status and reference, open the
  screenshot (`api/manage/payment-proof.js`, editors only, never cached), and tick **Paid**, which
  tells the person by push and Telegram. A ticked method that cannot be offered yet is explained
  under it, never refused: a link or QR code needs one amount (tiers, or no Up to), the link, or
  the QR code. People coming just for a meal pay nothing here. Taking back a paid RSVP asks first
  (refunds are the organisers' business). QR codes and screenshots live in the private
  `gftvevents_payments` bucket, and a screenshot is deleted when it is replaced or its RSVP goes
  (taken back, removed by an editor, the event or account deleted).
- **Each tier its own ways to pay.** A tier card ticks its own ways to pay (on the day, link, QR
  code), none for the event's, and can have its own payment link and QR code in place of the
  event's. Tiers keep an id, by which the server keeps a tier's QR code across autosaves (the form
  never sends it; it is uploaded on its own once the tier has saved). Checkout offers each ticket
  only its tier's ways, shows the link or QR code of the tier bought, and lets "Pay another way"
  pick only among them; a buyer can open only their own tier's QR code. The event page's ticket
  cards say how a tier is paid for when it differs from the event. Taking a tier away deletes its
  QR code.
- **"Just Lepak Only"** (migrations/017). A paid event can let people come without a ticket, to hang
  out: a third RSVP choice beside "The whole event" and "just for the meal", "Just Lepak Only"
  unless the editor typed other words. Lepak people are going like anyone else (address, RSVP ID,
  reminders), take none of the event's spaces (so a full event still takes them), can tick meals
  too, and have their own cap. Editors see them marked on the attendee list, with a count.
- **Editors of one event** (migrations/018). An admin adds any account active in the last 30 days
  as an editor of a specific event, from that event's Editors tab (admins only). An event editor
  sees only their events on `/manage` (no New event, no staff tools), edits every section and
  manages attendees, but cannot change the Status or release time (the server keeps them), create
  or delete events. Their rights work only while two-step sign-in (an authenticator app or a
  passkey) is on; the tab warns until it is. They preview their unreleased event and get "Edit this
  event" on it.
- **Event list by status.** `/manage`'s event list has Published (released or scheduled), Drafts and
  Cancelled, each with its count and pages; going back from the form opens the status of the event
  that was open.
- **Feed search.** The home page searches title, summary, venue, city, country and organiser, every
  word, within the When and Kind picked, as it is typed; the search is kept in the address
  (`/?q=...`). Typed symbols are only text: the search is a nested PostgREST filter under the
  release check (`event-rules.js releasedFilter`, `searchWords`).
- **Page tours** (`js/tour.js`, `js/tours.js`, after `docs/page-tour-spec.md`). The first time
  someone opens the feed, an event, checkout, their account or `/manage`, the page dims and a
  chalk arrow points at each thing worth knowing, one line at a time, with Next and Skip. Each tab
  (and each section of the edit form) has its own short tour the first time it is opened, and
  steps for things that are not on screen (another role's tabs, an empty list) are left out. The
  header's **?** button replays the tours for the page and tab on show. What has been seen is kept
  in `localStorage` (`tour.seen`); the end-to-end tests mark every tour seen unless a test asks
  otherwise.
- **Link previews.** `/e/<slug>` is served by `api/events/page.js`: `event.html` with the event's
  own title, when and where, summary and cover picture in its Open Graph and Twitter tags, so a
  link unfurls as the event in Discord, Telegram, WhatsApp, X and iMessage (the same idea as SG Bus
  Timings' share pages). The cover goes out as a JPEG from `api/events/embed-image.js`, since not
  every app reads WebP. Drafts and events not released yet get the site's own tags.
- **The account page** has the profile at the top and tabs below it: My events,
  Notifications, Security, and Profile: the country of origin for everyone, and for public
  accounts, renaming or deleting the account.
  The open tab is kept in the address (`/account#security`).
- **Notifications**, chosen on the account page: changes of time or place or timetable (or a cancellation) of
  events you are going to, reminders before them, and, off by default, new events. They go by
  Web Push to the browsers you switch on (subscriptions stored in Upstash Redis) and, if you choose,
  to your linked Telegram chat. A notice carries only what the public event page shows. Reminders
  and new-event notices come from the cron `/api/cron/notify`, every ten minutes. Because the edit
  form autosaves field by field, change notices are batched: they go out about 45 seconds after the
  editor's last save, once, comparing the event with how it was before the first change
  (migrations/006); the cron sends any left over.
- **Reminders** (migrations/011). Each account ticks any of 1 hour, 2 hours, 3 hours, 1 day and
  1 week before (a day before to start with). Each time goes at most once per RSVP, within five
  minutes of it; if two have come at once (a cron that was down), only the closer one goes. A time
  that came before someone said they were going is skipped, and an event whose start time is to
  be confirmed gets only the day and week reminders. The push notification, which can show on a
  locked screen, says only when and where. The Telegram reminder is a rich message (headings and
  tables, with a plain-text fallback) with everything someone going sees on the event page: when it
  starts and ends, the whole event or which meals they are coming for, the online link, every
  place (event location, meeting location, custom ones) with its street address, country and map
  link, and each meal held somewhere else with its own places (just their meals, for someone
  coming only for some), then the event link.

## Setup, in order

The Telegram bot (made with @BotFather) and Cloudflare Turnstile have their own step-by-step guide,
[`../SETUP.md`](../SETUP.md). Steps 6 and 7 below are the short version.

1. **Database.** In the Supabase SQL editor, run each file in `../migrations/` in number order,
   once, whole: `001_helloevents_schema.sql`, then `002_public_accounts_covers_notifications.sql`,
   then `003_resets_signup_allowances_name_filters.sql`, and each later one (004 to 020) in turn.
   Run `006_batched_change_notices.sql` before deploying the autosaving edit form: saving an
   event needs its two columns. Run `007_meal_only_rsvps.sql` before deploying meal-only RSVPs:
   the event page and RSVPs read its columns, and it replaces the RSVP function. Run
   `008_ticket_tiers.sql` before deploying ticket tiers: saving an event writes its columns. Run
   `009_meal_limits.sql` before deploying meal limits: the feed and event pages count spaces
   through its view, and it replaces the RSVP function again. `010_meal_changes_after_close.sql`
   replaces it once more, so people going can change their meals after RSVPs close. Run
   `011_reminder_times.sql` before deploying reminder times: the account page and the cron read
   its columns. Run `012_volunteers.sql` before deploying volunteers: the event pages, RSVPs and
   the edit form read its columns and table. Run `013_rsvp_numbers.sql` before deploying RSVP IDs: it numbers
   the RSVPs already there, and replaces the RSVP function so each new one gets the next number.
   Run `014_timetable.sql` before deploying timetables: the event pages and the edit form read
   its columns. Run `015_link_labels_cross_border.sql` before deploying link labels and
   cross-border events: sign-up, the account page, RSVPs and the event pages read its columns.
   Run `016_checkout_payments.sql` before deploying checkout: the event pages, RSVPs, the edit
   form and the attendee list read its columns, and it creates the private `gftvevents_payments`
   Storage bucket. Run `017_lepak.sql` before deploying "Just Lepak Only": it replaces the RSVP
   function (every RSVP sends its lepak setting) and the view the spaces are counted from. Run
   `018_event_editors.sql` before deploying editors of one event: the session, `/manage` and the
   event pages read its table. Run `019_event_gallery.sql` before deploying galleries: the event
   pages, the edit form and the cover upload read its table and the events' two new columns. Run
   `020_rich_descriptions_stickers.sql` before deploying rich descriptions and sticker packs: it
   allows longer descriptions, adds the sticker tables and creates the private
   `gftvevents_stickers` Storage bucket.
   A migration is never edited after it has run; changes go in a new numbered file. 002 also
   creates the `gftvevents_covers` Storage bucket.
2. **Environment variables.** In Vercel, set every name in `.env.example` (Production, and Preview
   if used). Required: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TOTP_ENCRYPTION_KEY`, `IP_HASH_SALT`,
   `CRON_SECRET`, and in Production `TURNSTILE_SECRET` and `TURNSTILE_HOSTNAMES` (step 7). Optional:
   Telegram, Web Push (`VAPID_*`) and Redis. Make random values
   with `openssl rand -hex 32`, and the push keys with `npx web-push generate-vapid-keys`.
3. **Redis (for push).** Vercel > Storage > Upstash for Redis (Marketplace), create a database and
   connect it to this project. Vercel sets `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
   Redeploy afterwards.
4. **Vercel project.** Root directory `main-site`. `vercel.json` sets the region (sin1), the
   `/e/<slug>` rewrite to the link-preview function (which bundles `event.html`), security headers, the daily cleanup cron and the notification cron (every ten minutes, so an hour-before reminder
   is on time; Vercel's Hobby plan runs crons only once a day, so this needs Pro).
5. **Domain.** Add `events.globalfurry.tv` to the Vercel project. Passkeys are bound to this
   hostname (`SITE_URL`), so they do not work on preview URLs.
6. **Telegram (optional).** Make a new bot with @BotFather (not the OneLink one: a bot has one
   webhook; [`../SETUP.md`](../SETUP.md) walks through BotFather, the command list and testing),
   set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and `TELEGRAM_WEBHOOK_SECRET`, deploy, then
   point the bot at the site:

   ```sh
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://events.globalfurry.tv/api/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["message"],"drop_pending_updates":true}'
   ```

   Check it with `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"`. Messages
   go out with `sendRichMessage` (Bot API 10.1 Rich Messages) and fall back to a plain message.
   Without Telegram, members reset a forgotten password with a backup code or a code from an admin.
7. **Turnstile.** The widget exists and its site key is built in (`api/_lib/turnstile.js`). In
   Cloudflare, check `events.globalfurry.tv` is on the widget's hostnames; in Vercel (Production)
   set `TURNSTILE_SECRET` to the widget's secret and `TURNSTILE_HOSTNAMES=events.globalfurry.tv`,
   then redeploy. It guards sign-in, sign-up and starting a password reset (actions `login`,
   `signup`, `reset`). Production without the secret refuses those forms (fail closed); local and
   preview deploys without it skip the check and show no widget. See [`../SETUP.md`](../SETUP.md)
   section 6.
8. **Android app link.** `.well-known/assetlinks.json` names `tv.globalfurry.events`; replace the
   placeholder fingerprint with the app signing key's SHA-256 before it is relied on.

## Checks

```sh
npm install
npm test             # unit and route tests, no network, database or Redis
npm run check-sw     # no skipWaiting() outside the update bar's message handler
npm run check-i18n   # en.json against every data-i18n key and t() call (see below)
npm run lint         # ESLint: the readability rules (no ternaries, ?. or ??)
```

Bump `VERSION` in `sw.js` on every deploy that changes a served file, or nobody sees the update bar.

`check-i18n` runs the shared scanner `assets/i18n/check-keys.js`, which finds keys in `t(` calls.
HelloEvents' own code calls `translate(` since help desk #18's job 03, so keys used only there
aren't checked against `en.json` until the shared scanner also looks for `translate(`.

**End-to-end tests:** `npm ci`, then `npm run test:e2e`.

- Playwright starts `tests/e2e/server.js`. It serves this folder the way Vercel does (`vercel.json`'s
  clean URLs, the `/e/<slug>` rewrite and the security headers, so the real Content-Security-Policy
  applies). It runs the real API handlers in `api/` against the in-memory database and Redis that
  `npm test` uses.
- It's seeded from `tests/e2e/seed.js` before every test, and picks a free port.
- No `.env`, network, database or Redis is needed. Turnstile runs on Cloudflare's test keys with a
  local stub, every request to another site is answered by the test, Telegram is off, and pushes are
  recorded rather than sent.
- A test fails on any console error, uncaught exception, server error, or API answer carrying a
  field from `tests/harness.js`'s `SECRET_FIELDS`.
- It needs Chromium revision 1254 (`@playwright/test` 1.65.0). On another machine, run
  `npx playwright install chromium` once.
- A failed test leaves a trace in `tests/e2e/output/`: open it with
  `npx playwright show-trace tests/e2e/output/<test>/trace.zip`.
- The seed's upcoming events are dated 2032; move them on before then.

## Icons

`../tools/make-icons.mjs` draws the icon (`../tools/GHE-icon.svg`) and renders `GHE-main.png`,
`GHE-512.png`, `GHE-192.png`, `GHE-180.png`, `favicon.ico` and the small `gftv-flag.png`:
`cd ../tools && npm install && npm run icons`.
