// The page tours (docs/page-tour-spec.md), as data. js/tour.js runs them.
//
// Each tour belongs to one page (`page`, the name the page's module passes to
// startTours) and applies while its `needs` element is showing: the page
// itself, or one tab's panel. On a first visit the first unseen tour that
// applies runs; when it ends, the next one does (the page's, then the open
// tab's, then the open editor section's), and opening another tab runs that
// tab's. The ? button in the header replays every tour that applies there
// and then, in order.
//
// A step lights the first visible match of `el` (a selector, or a list of
// them in order of preference) and says `i18n`. A step whose element is not
// showing is left out, so a tour adapts to the role, the event and what is
// filled in. `hint` marks the one step about the ? button, shown only in the
// first tour someone sees.
//
// Changing a tour does not show it again to people who have seen it; give it
// a new id if it must be.

export const TOURS = [
  // --- The event feed --------------------------------------------------
  {
    id: 'home',
    page: 'home',
    needs: '#feed',
    steps: [
      { el: '#feedSearch', i18n: 'tour.home.search' },
      { el: '#whenPicker', i18n: 'tour.home.when' },
      { el: '#kindPicker', i18n: 'tour.home.kind' },
      { el: ['#feed .event-card:not(.skeleton-card)', '#feedEmpty'], i18n: 'tour.home.feed' },
      { el: '.header-actions a[href="/login"]', i18n: 'tour.home.sign-in' },
      { el: '.header-actions a[href="/account"]', i18n: 'tour.home.account' },
      { el: '.header-actions a[href="/manage"]', i18n: 'tour.home.manage' },
      { el: '#tourBtn', i18n: 'tour.hint', hint: true },
    ],
  },

  // --- An event's page ---------------------------------------------------
  {
    id: 'event',
    page: 'event',
    needs: '#eventView',
    steps: [
      { el: '#previewNote', i18n: 'tour.event.preview' },
      { el: '.event-aside .facts', i18n: 'tour.event.facts' },
      { el: '#rsvpSignIn', i18n: 'tour.event.sign-in' },
      { el: '#rsvpCountry', i18n: 'tour.event.country' },
      { el: '#rsvpMeals', i18n: 'tour.event.meals' },
      { el: '#rsvpVolunteerRow', i18n: 'tour.event.volunteer' },
      { el: '#rsvpBtn', i18n: 'tour.event.rsvp' },
      { el: '#rsvpForLepakRow', i18n: 'tour.event.lepak' },
      { el: '#rsvpCheckout', i18n: 'tour.event.checkout' },
      { el: '#rsvpPayment', i18n: 'tour.event.payment' },
      { el: '#timetableBox', i18n: 'tour.event.timetable' },
      { el: '#manageLink', i18n: 'tour.event.manage' },
      { el: '#tourBtn', i18n: 'tour.hint', hint: true },
    ],
  },

  // Registration forms (migrations/024): the form with an RSVP, and the
  // Registration details card for someone going.
  {
    id: 'event.registration-form',
    page: 'event',
    needs: '#rsvpRegistration',
    steps: [
      { el: '#rsvpRegistration', i18n: 'tour.event.registration-form' },
      { el: '#rsvpRegistration .reg-account', i18n: 'tour.event.registration-account' },
      { el: '#rsvpRegistration .reg-photo', i18n: 'tour.event.registration-photo' },
    ],
  },
  {
    id: 'event.registration',
    page: 'event',
    needs: '#registrationBox',
    steps: [
      { el: '#registrationBox .reg-card-head', i18n: 'tour.event.registration-card' },
      { el: '#registrationBox .reg-badge-number', i18n: 'tour.event.registration-badge' },
      { el: '#registrationBox .reg-edit', i18n: 'tour.event.registration-edit' },
      { el: '#registrationBox .reg-upgrade', i18n: 'tour.event.registration-upgrade' },
    ],
  },

  // --- Checkout (migrations/016) -------------------------------------------
  {
    id: 'checkout',
    page: 'checkout',
    needs: '#orderBox',
    steps: [
      { el: '#ticketStep', i18n: 'tour.checkout.ticket' },
      { el: '#methodStep', i18n: 'tour.checkout.method' },
      { el: '#orderSummary', i18n: 'tour.checkout.order' },
      { el: '#tourBtn', i18n: 'tour.hint', hint: true },
    ],
  },
  {
    id: 'checkout.pay',
    page: 'checkout',
    needs: '#payBox',
    steps: [
      { el: '#payStatus', i18n: 'tour.checkout.status' },
      { el: ['#payQrBox', '#payLink'], i18n: 'tour.checkout.pay' },
      { el: '#reportForm', i18n: 'tour.checkout.report' },
      { el: '#switchBox', i18n: 'tour.checkout.switch' },
    ],
  },
  {
    id: 'checkout.registration',
    page: 'checkout',
    needs: '#registrationStep',
    steps: [
      { el: '#registrationStep', i18n: 'tour.checkout.registration' },
      { el: '#registrationStep .reg-amount', i18n: 'tour.checkout.registration-donation' },
    ],
  },
  {
    id: 'checkout.upgrade',
    page: 'checkout',
    needs: '#upgradeBox',
    steps: [
      { el: '#upgradeList', i18n: 'tour.checkout.upgrade-pick' },
      { el: '#upgradeBtn', i18n: 'tour.checkout.upgrade-pay' },
    ],
  },

  // --- Account -----------------------------------------------------------
  {
    id: 'account',
    page: 'account',
    needs: '#accountView',
    steps: [
      { el: '#signOutOthers', i18n: 'tour.account.sign-out-others' },
      { el: '#tab-going', i18n: 'tour.account.tab-going' },
      { el: '#tab-notifications', i18n: 'tour.account.tab-notifications' },
      { el: '#tab-security', i18n: 'tour.account.tab-security' },
      { el: '#tab-profile', i18n: 'tour.account.tab-profile' },
      { el: '#tourBtn', i18n: 'tour.hint', hint: true },
    ],
  },
  {
    id: 'account.going',
    page: 'account',
    needs: '#panel-going',
    steps: [
      { el: ['#rsvpUpcoming .event-card', '#rsvpEmpty'], i18n: 'tour.account.going-list' },
      { el: '#pastBox', i18n: 'tour.account.going-past' },
    ],
  },
  {
    id: 'account.notifications',
    page: 'account',
    needs: '#panel-notifications',
    steps: [
      { el: 'label:has(> #prefUpdates)', i18n: 'tour.account.notify-updates' },
      { el: '#prefReminders', i18n: 'tour.account.notify-reminders' },
      { el: ['#pushOn', '#pushOff', '#pushState'], i18n: 'tour.account.notify-device' },
      { el: '#notifyTelegramBox', i18n: 'tour.account.notify-telegram' },
    ],
  },
  {
    id: 'account.security',
    page: 'account',
    needs: '#panel-security',
    steps: [
      { el: ['#totpAdd', '#totpRemove'], i18n: 'tour.account.security-totp' },
      { el: '#passkeyAdd', i18n: 'tour.account.security-passkey' },
      { el: '#telegramBox', i18n: 'tour.account.security-telegram' },
      { el: '#backupNew', i18n: 'tour.account.security-backup' },
    ],
  },
  // Email codes (migrations/028), a tour of its own so people who saw the
  // Security tab before see it too; only where the site sends email.
  {
    id: 'account.security-email',
    page: 'account',
    needs: '#emailBox',
    steps: [
      { el: '#emailBox', i18n: 'tour.account.security-email' },
    ],
  },
  {
    id: 'account.profile',
    page: 'account',
    needs: '#panel-profile',
    steps: [
      { el: '#nameForm', i18n: 'tour.account.profile-name' },
      { el: '#deleteBox', i18n: 'tour.account.profile-delete' },
    ],
  },
  // Personal details (migrations/024), a tour of its own so people who saw
  // the Profile tab before see it too.
  {
    id: 'account.personal',
    page: 'account',
    needs: '#panel-profile',
    steps: [
      { el: '.field:has(#legalNameInput)', i18n: 'tour.account.personal-name' },
      { el: ['#personalLocked', '#countrySubmit'], i18n: 'tour.account.personal-locked' },
      { el: '.field:has(#emergencyNameInput)', i18n: 'tour.account.personal-emergency' },
    ],
  },
  // ID verification (migrations/027) and Telegram sticker packs, a tour of
  // their own for the same reason.
  {
    id: 'account.profile-extras',
    page: 'account',
    needs: '#panel-profile',
    steps: [
      { el: '#idBox', i18n: 'tour.account.profile-idcheck' },
      { el: '#stickerBox', i18n: 'tour.account.profile-stickers' },
    ],
  },

  // --- Manage: the page and its tabs --------------------------------------
  {
    id: 'manage',
    page: 'manage',
    needs: '#newEvent',
    steps: [
      { el: '#tab-events', i18n: 'tour.manage.tab-events' },
      { el: '#tab-editor', i18n: 'tour.manage.tab-editor' },
      { el: '#tab-idreviews', i18n: 'tour.manage.tab-idreviews' },
      { el: '#tab-tuning', i18n: 'tour.manage.tab-tuning' },
      { el: '#tab-filter', i18n: 'tour.manage.tab-filter' },
      { el: '#tab-reset', i18n: 'tour.manage.tab-reset' },
      { el: '#newEvent', i18n: 'tour.manage.new' },
      { el: '#tourBtn', i18n: 'tour.hint', hint: true },
    ],
  },
  {
    id: 'manage.events',
    page: 'manage',
    needs: '#listBox',
    steps: [
      { el: '#listStatus', i18n: 'tour.manage.list-filter' },
      { el: '#eventList .item-row .chip', i18n: 'tour.manage.list-status' },
      { el: '#eventList .item-row .btn', i18n: 'tour.manage.list-edit' },
      { el: '#listEmpty', i18n: 'tour.manage.list-empty' },
      { el: '#listPager', i18n: 'tour.manage.list-pages' },
    ],
  },
  {
    id: 'manage.editor',
    page: 'manage',
    needs: '#eventForm',
    steps: [
      { el: '#editorTabs', i18n: 'tour.editor.sections' },
      { el: '#autosaveStatus', i18n: 'tour.editor.autosave' },
      { el: '#editorView', i18n: 'tour.editor.view' },
      { el: '#editorDelete', i18n: 'tour.editor.delete' },
    ],
  },

  // --- Manage: the edit form's sections -----------------------------------
  {
    id: 'editor.basics',
    page: 'manage',
    needs: '#epanel-basics',
    steps: [
      { el: '.field:has(#f-status)', i18n: 'tour.editor.basics-status' },
      { el: '.field:has(#f-publishLocal)', i18n: 'tour.editor.basics-release' },
      { el: '.field:has(#f-slug)', i18n: 'tour.editor.basics-slug' },
      { el: 'label:has(> #f-crossBorder)', i18n: 'tour.editor.basics-cross-border' },
      { el: '#descriptionSwitch', i18n: 'tour.editor.basics-descriptions' },
      { el: '.cover-field', i18n: 'tour.editor.basics-cover' },
    ],
  },
  {
    id: 'editor.when',
    page: 'manage',
    needs: '#epanel-when',
    steps: [
      { el: '.field:has(#f-timezone)', i18n: 'tour.editor.when-zone' },
      { el: 'label:has(> #f-datesHidden)', i18n: 'tour.editor.when-tba' },
      { el: '#locationAdd', i18n: 'tour.editor.when-locations' },
      { el: 'label:has(> #f-addressAttendeesOnly)', i18n: 'tour.editor.when-private' },
    ],
  },
  {
    id: 'editor.price',
    page: 'manage',
    needs: '#epanel-price',
    steps: [
      { el: 'label:has(> #f-tiersEnabled)', i18n: 'tour.editor.price-tiers' },
      { el: '#paymentSection', i18n: 'tour.editor.price-payment' },
      { el: '#lepakSection', i18n: 'tour.editor.price-lepak' },
      { el: '.field:has(#f-capacity)', i18n: 'tour.editor.price-capacity' },
      { el: '#contactSection', i18n: 'tour.editor.price-contact' },
      { el: '#volunteerSection', i18n: 'tour.editor.price-volunteers' },
      { el: '.field:has(> [data-key="closesLocal"])', i18n: 'tour.editor.registration-tier-closes' },
    ],
  },
  // The registration form (migrations/024), in a paid event's Questions tab,
  // each question for every tier or only some.
  {
    id: 'editor.questions',
    page: 'manage',
    needs: '#epanel-questions',
    steps: [
      { el: 'label:has(> #f-registrationEnabled)', i18n: 'tour.editor.registration-on' },
      { el: '#registrationPresets', i18n: 'tour.editor.registration-presets' },
      { el: '.reg-tiers', i18n: 'tour.editor.registration-tiers' },
      { el: '#registrationAdd', i18n: 'tour.editor.registration-own' },
    ],
  },
  {
    id: 'editor.meals',
    page: 'manage',
    needs: '#epanel-meals',
    steps: [
      { el: '#epanel-meals .meal-rows', i18n: 'tour.editor.meals-pick' },
      { el: '.meal-place', i18n: 'tour.editor.meals-elsewhere' },
      { el: '#mealAdd', i18n: 'tour.editor.meals-more' },
    ],
  },
  {
    id: 'editor.timetable',
    page: 'manage',
    needs: '#epanel-timetable',
    steps: [
      { el: '.field:has(#f-timetableView)', i18n: 'tour.editor.timetable-view' },
      { el: '#roomsFieldset', i18n: 'tour.editor.timetable-rooms' },
      { el: '#itemAdd', i18n: 'tour.editor.timetable-items' },
    ],
  },
  {
    id: 'editor.people',
    page: 'manage',
    needs: '#epanel-people',
    steps: [
      { el: '.field:has(#f-staffNotes)', i18n: 'tour.editor.people-notes' },
      { el: '#attendeesBox', i18n: 'tour.editor.people-list' },
      { el: '#attendeesPayments', i18n: 'tour.editor.people-payments' },
      { el: '#attendeesVolunteers', i18n: 'tour.editor.people-volunteers' },
    ],
  },

  {
    id: 'editor.editors',
    page: 'manage',
    needs: '#epanel-editors',
    steps: [
      { el: '#eventEditorAdd', i18n: 'tour.editor.editors-add' },
      { el: '#eventEditorList', i18n: 'tour.editor.editors-list' },
    ],
  },

  // --- Manage: the staff tools --------------------------------------------
  {
    id: 'manage.filter',
    page: 'manage',
    needs: '#panel-filter',
    steps: [
      { el: 'p:has(> #builtInTerms)', i18n: 'tour.tools.filter-builtin' },
      { el: '#filterForm', i18n: 'tour.tools.filter-add' },
      { el: '#flaggedList li', i18n: 'tour.tools.filter-flagged' },
    ],
  },
  {
    id: 'manage.reset',
    page: 'manage',
    needs: '#panel-reset',
    steps: [
      { el: '.field:has(#resetUsername)', i18n: 'tour.tools.reset-check' },
      { el: '#resetSubmit', i18n: 'tour.tools.reset-code' },
    ],
  },
  {
    id: 'manage.personal-fix',
    page: 'manage',
    needs: '#personalFixBox',
    steps: [
      { el: '#personalFixForm', i18n: 'tour.tools.personal-fix' },
    ],
  },
];

// Every tour's id, and the replay hint's: what tests mark as seen so no tour
// covers the page they look at.
export const TOUR_IDS = [...TOURS.map((tour) => tour.id), 'hint'];
