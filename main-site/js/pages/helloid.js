// HelloID (/helloid, migrations/027): this site's own, free ID check.
//
//   1. Which ID: the issuing country (the connection's, from the server; the
//      person can change it) and the documents it issues
//      (js/helloid-documents.js).
//   2. Consent.
//   3. A photo of the ID (front, then back for a card) with the camera, or
//      the phone's camera app where the page cannot open the camera. The
//      server reads a machine-readable zone when there is one; when it
//      cannot read it clearly, the person is asked for a clearer photo of
//      that side (MAX_RETAKES times, then they may carry on with it).
//   4. The legal name and date of birth it is for: the account's own when
//      set (locked), else what the zone gave (to confirm or correct), or
//      typed.
//   5. The live face check, once they confirm their screen is at full
//      brightness: a challenge from the server (turn left, right, up, down,
//      in its order; then the screen flashes its colours), frames taken at
//      set moments. When the face part does not pass (or the face does not
//      match the ID photo), the server asks for it again (api/me/helloid.js,
//      up to its own limit, with a signed record of the earlier goes the
//      page sends back) and the page says what to do differently:
//      brightness up, turn further, face in view, glasses off.
//   6. Sending everything, and the result. A dropped connection keeps it
//      all here and sends it again once the connection is back.

import { session } from '../app.js';
import { t as translate, onChange } from '../../assets/i18n/i18n.js';
import { api, post } from '../api.js';
import { createElement, errorText } from '../ui.js';
import { iconNode } from '../icons.js';
import { fillCountrySelect, countryName } from '../choices.js';
import { documentsFor } from '../helloid-documents.js';

const byId = (id) => document.getElementById(id);
const STEPS = ['stepDocument', 'stepConsent', 'stepCapture', 'stepDetails', 'stepLive', 'stepResult'];
const ID_SIDE = 1600;
const FRAME_SIDE = 480;
const TURN_WAIT_MS = 1600;
const TURN_GAP_MS = 450;
const FLASH_MS = 550;
const FLASH_CAPTURE_MS = 380;
const COLOURS = { red: '#ff0000', green: '#00ff00', blue: '#0000ff' };

let standing = null;
let country = 'SG';
let picked = null; // the document type picked
let sides = {}; // { front, back } as data URLs
let sideIndex = 0;
let read = null; // { name, birth } read from the zone, or null
let docStream = null;
let faceStream = null;
let cameraLabel = '';
let pending = null; // the submission, kept until it is sent
let retakes = 0; // clearer photos asked for, this try
let retaking = false; // taking the zone's side again
let faceHistory = null; // the server's signed record of earlier goes
const MAX_RETAKES = 2;

function show(step) {
  for (const id of STEPS) {
    byId(id).hidden = id !== step;
  }
  byId('helloidLoading').hidden = true;
  window.scrollTo(0, 0);
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nextPath() {
  const next = new URLSearchParams(location.search).get('next');
  if (next && /^\/e\/[a-z0-9-]{3,60}$/.test(next)) {
    return next;
  }
  return null;
}

function accountHref() {
  let href = '/account';
  if (nextPath()) {
    href += `?next=${encodeURIComponent(nextPath())}`;
  }
  return `${href}#profile`;
}

// ---------------------------------------------------------------------------
// 1. Which ID
// ---------------------------------------------------------------------------

function renderDocuments() {
  byId('countryName').textContent = countryName(country);
  const list = documentsFor(country).map((document) => createElement('li', {}, [
    createElement('button', { type: 'button', class: 'helloid-document', onclick: () => pickDocument(document) }, [
      iconNode(document.icon),
      createElement('span', { text: translate(`helloid.document.${document.type}`) }),
      iconNode('arrow-right'),
    ]),
  ]));
  byId('documentList').replaceChildren(...list);
  byId('helloidAlready').hidden = !standing.verified;
  byId('helloidWaiting').hidden = !standing.pending;
  byId('documentList').hidden = standing.verified;
}

function pickDocument(document) {
  picked = document;
  sides = {};
  sideIndex = 0;
  read = null;
  retakes = 0;
  retaking = false;
  faceHistory = null;
  byId('consentBox').checked = false;
  byId('consentNext').disabled = true;
  show('stepConsent');
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

function stopStream(stream) {
  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}

async function openCamera(video, facing) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('no_camera');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  const track = stream.getVideoTracks()[0];
  if (track && track.label) {
    cameraLabel = track.label;
  }
  return stream;
}

// The video's picture now, at most `side` px on its longer side, as a JPEG.
function grab(video, side, quality) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const scale = Math.min(1, side / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

// A picture file (from the phone's camera app) as a JPEG data URL.
async function fileToJpeg(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, ID_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.9);
}

// ---------------------------------------------------------------------------
// 3. The ID's photo
// ---------------------------------------------------------------------------

function currentSide() {
  return picked.sides[sideIndex];
}

// retake: asking again for the side with the zone, which could not be
// read clearly; the tips show, and they may carry on with the last photo.
async function startCapture({ retake = false } = {}) {
  retaking = retake;
  byId('captureRetake').hidden = !retake;
  byId('docSkip').hidden = !retake;
  const side = currentSide();
  byId('captureTitle').textContent = translate(`helloid.capture-${side}`, { document: translate(`helloid.document.${picked.type}`) });
  let hint = 'helloid.capture-hint';
  if (picked.mrz === side) {
    hint = 'helloid.capture-hint-mrz';
  }
  byId('captureHint').textContent = translate(hint);
  byId('captureError').textContent = '';
  byId('docPreview').hidden = true;
  byId('docVideo').hidden = false;
  byId('docShoot').hidden = false;
  byId('docRetake').hidden = true;
  byId('docUse').hidden = true;
  byId('docFileLabel').hidden = true;
  show('stepCapture');
  if (retake) {
    byId('captureRetake').scrollIntoView({ block: 'nearest' });
  }
  if (!docStream) {
    try {
      docStream = await openCamera(byId('docVideo'), 'environment');
    } catch {
      // No camera here (or not allowed): the phone's camera app instead.
      byId('docShoot').hidden = true;
      byId('docFileLabel').hidden = false;
      byId('captureError').textContent = translate('helloid.camera-blocked');
    }
  }
}

function showPreview(dataUrl) {
  sides[currentSide()] = dataUrl;
  byId('docPreview').src = dataUrl;
  byId('docPreview').hidden = false;
  byId('docVideo').hidden = true;
  byId('docShoot').hidden = true;
  byId('docRetake').hidden = false;
  byId('docUse').hidden = false;
  byId('docSkip').hidden = true;
}

async function useSide() {
  // A retake is of the zone's side alone.
  if (!retaking && sideIndex + 1 < picked.sides.length) {
    sideIndex += 1;
    await startCapture();
    return;
  }
  stopStream(docStream);
  docStream = null;
  await readDocument();
}

// Reads the zone (when the document has one) for the name and date of
// birth to confirm, then the details step. A zone read but not clearly, or
// not found, asks for a clearer photo of its side first.
async function readDocument() {
  read = null;
  if (picked.mrz) {
    byId('helloidLoading').hidden = false;
    for (const id of STEPS) {
      byId(id).hidden = true;
    }
    let zone = 'clear';
    try {
      const body = { action: 'read', country, type: picked.type, front: sides.front };
      if (sides.back) {
        body.back = sides.back;
      }
      const answer = await post('/api/me/helloid', body);
      read = answer.read;
      zone = answer.zone;
    } catch {
      // Not read (a dropped connection): the check reads it again.
      read = null;
    }
    if (zone !== 'clear' && retakes < MAX_RETAKES) {
      retakes += 1;
      sideIndex = picked.sides.indexOf(picked.mrz);
      await startCapture({ retake: true });
      return;
    }
  }
  showDetails();
}

// Carrying on with a photo whose zone could not be read clearly: the
// admins compare it by eye.
async function skipRetake() {
  retaking = false;
  stopStream(docStream);
  docStream = null;
  showDetails();
}

// ---------------------------------------------------------------------------
// 4. The details
// ---------------------------------------------------------------------------

function showDetails() {
  retaking = false;
  const personal = standing.personal;
  const name = byId('detailsName');
  const birth = byId('detailsBirth');
  birth.max = new Date().toISOString().slice(0, 10);
  name.disabled = Boolean(personal.legalName);
  birth.disabled = Boolean(personal.dateOfBirth);
  name.value = '';
  birth.value = '';
  if (personal.legalName) {
    name.value = personal.legalName;
  } else if (read) {
    name.value = read.name;
  }
  if (personal.dateOfBirth) {
    birth.value = personal.dateOfBirth;
  } else if (read) {
    birth.value = read.birth;
  }
  let hint = 'helloid.details-type';
  if (personal.legalName && personal.dateOfBirth) {
    hint = 'helloid.details-account';
  } else if (read) {
    hint = 'helloid.details-read';
  }
  byId('detailsHint').textContent = translate(hint);
  byId('detailsError').textContent = '';
  show('stepDetails');
}

// ---------------------------------------------------------------------------
// 5. The live face check
// ---------------------------------------------------------------------------

function prompt(key) {
  byId('livePrompt').textContent = translate(key);
}

// The face check's step, fresh (retry: the server's reason the last go did
// not pass, shown with what to do about it). The brightness box is ticked
// again each time.
function showLive(retry = null) {
  const notice = byId('liveRetry');
  notice.hidden = retry === null;
  if (retry !== null) {
    notice.textContent = translate(`helloid.retry-${retry.reason}`, { count: retry.of - retry.tries });
  }
  byId('liveBright').checked = false;
  byId('liveStart').disabled = true;
  byId('liveError').textContent = '';
  show('stepLive');
}

async function startLive() {
  byId('liveError').textContent = '';
  byId('liveStart').disabled = true;
  let started = false;
  try {
    const { challenge } = await api('/api/me/helloid?challenge=1');
    if (!faceStream) {
      faceStream = await openCamera(byId('faceVideo'), 'user');
    }
    const video = byId('faceVideo');
    started = true;
    prompt('helloid.prompt-straight');
    await wait(1800);
    const neutral = grab(video, FRAME_SIDE, 0.85);
    const turns = [];
    for (const turn of challenge.turns) {
      prompt(`helloid.prompt-${turn}`);
      await wait(TURN_WAIT_MS);
      const first = grab(video, FRAME_SIDE, 0.8);
      await wait(TURN_GAP_MS);
      turns.push([first, grab(video, FRAME_SIDE, 0.8)]);
      prompt('helloid.prompt-back');
      await wait(700);
    }
    prompt('helloid.prompt-flash');
    await wait(1400);
    const flash = byId('flash');
    flash.hidden = false;
    const flashes = [];
    for (const colour of challenge.flashes) {
      flash.style.background = COLOURS[colour];
      await wait(FLASH_CAPTURE_MS);
      flashes.push(grab(video, FRAME_SIDE, 0.85));
      await wait(FLASH_MS - FLASH_CAPTURE_MS);
    }
    flash.hidden = true;
    stopStream(faceStream);
    faceStream = null;
    prompt('');
    pending = {
      action: 'submit',
      consent: true,
      country,
      type: picked.type,
      front: sides.front,
      challenge: challenge.token,
      neutral,
      turns,
      flashes,
      device: deviceInfo(),
    };
    if (sides.back) {
      pending.back = sides.back;
    }
    if (faceHistory) {
      pending.faceHistory = faceHistory;
    }
    if (!byId('detailsName').disabled) {
      pending.name = byId('detailsName').value;
    }
    if (!byId('detailsBirth').disabled) {
      pending.birth = byId('detailsBirth').value;
    }
    await send();
  } catch (error) {
    byId('flash').hidden = true;
    let text = errorText(error);
    if (error && error.name === 'NotAllowedError') {
      text = translate('helloid.camera-blocked');
    }
    byId('liveError').textContent = text;
  } finally {
    byId('liveStart').disabled = !byId('liveBright').checked;
    if (started) {
      prompt('');
    }
  }
}

// What HelloID's device check reads (Device & IP analysis).
function deviceInfo() {
  let platform = navigator.platform;
  if (navigator.userAgentData && navigator.userAgentData.platform) {
    platform = navigator.userAgentData.platform;
  }
  let touch = false;
  if (navigator.maxTouchPoints > 0) {
    touch = true;
  }
  return {
    camera: cameraLabel,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: `${screen.width}x${screen.height}`,
    platform,
    cores: navigator.hardwareConcurrency,
    touch,
    webdriver: navigator.webdriver === true,
  };
}

// ---------------------------------------------------------------------------
// 6. Sending, and the result
// ---------------------------------------------------------------------------

function showResult(titleKey, textKey, { retry = false, done = false, again = false, placeholders = {} } = {}) {
  byId('resultTitle').textContent = translate(titleKey);
  byId('resultText').textContent = translate(textKey, placeholders);
  byId('resultRetry').hidden = !retry;
  byId('resultContinue').hidden = !done;
  byId('resultContinue').href = accountHref();
  if (nextPath() && done) {
    byId('resultContinue').href = nextPath();
  }
  byId('resultAgain').hidden = !again;
  show('stepResult');
}

async function send() {
  showResult('helloid.sending-title', 'helloid.sending');
  let data;
  try {
    data = await post('/api/me/helloid', pending);
  } catch (error) {
    if (error && error.code === 'offline') {
      showResult('helloid.offline-title', 'helloid.offline', { retry: true });
      window.addEventListener('online', send, { once: true });
      return;
    }
    if (error && error.code === 'helloid_challenge_expired') {
      pending = null;
      showResult('helloid.failed-title', 'error.helloid_challenge_expired', { again: true });
      return;
    }
    showResult('helloid.failed-title', 'helloid.failed', { retry: true, again: true, placeholders: { reason: errorText(error) } });
    return;
  }
  pending = null;
  if (data.retry) {
    faceHistory = data.retry.history;
    showLive(data.retry);
    return;
  }
  standing = data.helloid;
  const latest = standing.latest;
  if (standing.verified) {
    showResult('helloid.approved-title', 'helloid.approved', { done: true });
  } else if (latest && latest.status === 'pending') {
    showResult('helloid.review-title', 'helloid.review', { done: true });
  } else if (latest && latest.failure === 'document_used') {
    showResult('helloid.failed-title', 'idcheck.document-used', { done: true });
  } else {
    showResult('helloid.failed-title', 'helloid.failed', { again: true, placeholders: { reason: '' } });
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function wire() {
  byId('helloidBack').href = accountHref();
  byId('countryChange').addEventListener('click', () => {
    byId('countryField').hidden = false;
    fillCountrySelect(byId('countrySelect'), country);
    byId('countrySelect').focus();
  });
  byId('countrySelect').addEventListener('change', () => {
    if (byId('countrySelect').value) {
      country = byId('countrySelect').value;
      byId('countryField').hidden = true;
      renderDocuments();
    }
  });
  byId('consentBox').addEventListener('change', () => {
    byId('consentNext').disabled = !byId('consentBox').checked;
  });
  byId('consentNext').addEventListener('click', startCapture);
  byId('docShoot').addEventListener('click', () => {
    const video = byId('docVideo');
    if (!video.videoWidth) {
      return;
    }
    showPreview(grab(video, ID_SIDE, 0.9));
  });
  byId('docRetake').addEventListener('click', () => startCapture({ retake: retaking }));
  byId('docUse').addEventListener('click', useSide);
  byId('docFile').addEventListener('change', async () => {
    const file = byId('docFile').files[0];
    byId('docFile').value = '';
    if (!file) {
      return;
    }
    try {
      showPreview(await fileToJpeg(file));
      byId('docFileLabel').hidden = false;
    } catch {
      byId('captureError').textContent = translate('error.helloid_pictures_invalid');
    }
  });
  byId('detailsNext').addEventListener('click', () => {
    if (!byId('detailsName').value.trim() || !byId('detailsBirth').value) {
      byId('detailsError').textContent = translate('helloid.details-needed');
      return;
    }
    showLive();
  });
  byId('liveBright').addEventListener('change', () => {
    byId('liveStart').disabled = !byId('liveBright').checked;
  });
  byId('liveStart').addEventListener('click', startLive);
  byId('docSkip').addEventListener('click', skipRetake);
  byId('resultRetry').addEventListener('click', () => {
    if (pending) {
      send();
    }
  });
  byId('resultAgain').addEventListener('click', () => {
    pending = null;
    show('stepDocument');
  });
}

async function start() {
  const currentSession = await session;
  if (!currentSession.signedIn) {
    location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    return;
  }
  wire();
  try {
    standing = (await api('/api/me/helloid')).helloid;
  } catch (error) {
    byId('helloidLoading').hidden = true;
    showResult('helloid.failed-title', 'helloid.failed', { placeholders: { reason: errorText(error) } });
    return;
  }
  country = standing.country;
  renderDocuments();
  show('stepDocument');
}

onChange(() => {
  if (standing && !byId('stepDocument').hidden) {
    renderDocuments();
  }
});

start();
