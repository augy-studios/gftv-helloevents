// The admins' ID reviews tab on /manage (migrations/027,
// api/manage/helloid.js): the HelloID checks that could not clear on its own,
// each with the ID photo (front and back), the selfie, the legal name and
// date of birth it is for, and what the checks found. Approve, or decline
// with a reason the person sees.

import { t as translate } from '../assets/i18n/i18n.js';
import { api, post } from './api.js';
import { createElement, withBusy, formatDate } from './ui.js';
import { iconNode } from './icons.js';
import { countryName } from './choices.js';

const byId = (id) => document.getElementById(id);
let reviews = [];

const CHECKS = ['turns', 'flashes', 'samePerson', 'faceMatch', 'mrz'];

function mark(passed) {
  if (passed === true) {
    return iconNode('check');
  }
  return iconNode('x-circle');
}

// What the checks found, as lines: each check's outcome, then the numbers.
function findingLines(findings) {
  const lines = [];
  let checks = findings.checks;
  if (!checks) {
    checks = {};
  }
  for (const check of CHECKS) {
    let detail = '';
    if (check === 'faceMatch' && typeof findings.faceMatch === 'number') {
      detail = translate('admin.idreview-score', { score: findings.faceMatch });
    }
    if (check === 'flashes' && findings.flashes) {
      detail = translate('admin.idreview-flashes', { matched: findings.flashes.matched, of: findings.flashes.of });
    }
    lines.push(createElement('li', { class: `finding finding-${checks[check] === true}` }, [
      mark(checks[check]),
      createElement('span', { text: translate(`admin.idreview-check.${check}`) }),
      createElement('span', { class: 'muted small', text: detail }),
    ]));
  }
  if (findings.mrz) {
    const parts = [findings.mrz.name, findings.mrz.birth, translate('admin.idreview-expiry', { date: findings.mrz.expiry })];
    lines.push(createElement('li', { class: 'muted small', text: translate('admin.idreview-mrz', { read: parts.filter((part) => part).join(' · ') }) }));
  }
  if (findings.device) {
    const device = findings.device;
    const parts = [device.camera, device.ipCountry, device.timeZone].filter((part) => part);
    lines.push(createElement('li', { class: 'muted small', text: translate('admin.idreview-device', { device: parts.join(' · ') }) }));
  }
  let flags = findings.flags;
  if (!Array.isArray(flags)) {
    flags = [];
  }
  for (const flag of flags) {
    let text = translate(`admin.idreview-flag.${flag}`);
    if (flag === 'face_seen_elsewhere' && findings.faceSeenElsewhere) {
      text = translate('admin.idreview-flag.face_seen_elsewhere_named', { username: findings.faceSeenElsewhere.account });
    }
    lines.push(createElement('li', { class: 'callout warn small', text }));
  }
  let notes = findings.notes;
  if (!Array.isArray(notes)) {
    notes = [];
  }
  for (const note of notes) {
    lines.push(createElement('li', { class: 'muted small', text: translate(`admin.idreview-note.${note}`) }));
  }
  return lines;
}

function reviewItem(review) {
  let name = review.displayName;
  if (!name) {
    name = review.username;
  }
  const findings = review.findings;
  let documentText = '';
  if (findings.document) {
    documentText = `${translate(`helloid.document.${findings.document.type}`)} · ${countryName(findings.document.country)}`;
  }
  let typed = '';
  if (!review.accountHadName) {
    typed = ` (${translate('admin.idreview-typed')})`;
  }
  const reason = createElement('input', { type: 'text', maxlength: '200', placeholder: translate('admin.idreview-reason'), 'aria-label': translate('admin.idreview-reason-named', { name }) });
  const decide = (action) => withBusy(null, byId('idReviewError'), async () => {
    const data = await post('/api/manage/helloid', { action, check: review.check, reason: reason.value });
    reviews = data.reviews;
    render();
  });
  return createElement('li', { class: 'glass-card id-review' }, [
    createElement('div', { class: 'id-review-head' }, [
      createElement('strong', { text: name }),
      createElement('span', { class: 'muted small', text: `${review.username} · ${formatDate(review.submittedAt)}` }),
      createElement('span', { class: 'small', text: documentText }),
    ]),
    createElement('div', { class: 'id-review-photos' }, [
      createElement('a', { href: review.idPhotoUrl, target: '_blank', rel: 'noopener' }, [createElement('img', { src: review.idPhotoUrl, alt: translate('admin.idreview-id-alt', { name }), loading: 'lazy' })]),
      createElement('a', { href: review.selfieUrl, target: '_blank', rel: 'noopener' }, [createElement('img', { src: review.selfieUrl, alt: translate('admin.idreview-selfie-alt', { name }), loading: 'lazy' })]),
    ]),
    createElement('p', { class: 'small', text: translate('admin.idreview-for', { name: review.legalName, birth: review.dateOfBirth }) + typed }),
    createElement('ul', { class: 'findings' }, findingLines(findings)),
    createElement('div', { class: 'row id-review-actions' }, [
      createElement('button', { class: 'btn btn-primary', type: 'button', onclick: () => decide('approve') }, [iconNode('check'), createElement('span', { text: translate('admin.idreview-approve') })]),
      reason,
      createElement('button', { class: 'btn btn-danger', type: 'button', onclick: () => decide('decline') }, [iconNode('x-circle'), createElement('span', { text: translate('admin.idreview-decline') })]),
    ]),
  ]);
}

function render() {
  byId('idReviewList').replaceChildren(...reviews.map(reviewItem));
  byId('idReviewsNone').hidden = reviews.length > 0;
  let count = '';
  if (reviews.length > 0) {
    count = String(reviews.length);
  }
  byId('idReviewCount').textContent = count;
}

export async function startIdReviews() {
  try {
    reviews = (await api('/api/manage/helloid')).reviews;
  } catch {
    return;
  }
  byId('tab-idreviews').hidden = false;
  render();
}

export function relabelIdReviews() {
  render();
}
