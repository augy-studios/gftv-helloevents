// Checkout (migrations/016), from both sides: an editor sets up payment by
// link and QR code (and sees why a method is not offered yet), a member gets
// a ticket from the event page, pays by QR code and reports it with a
// screenshot, and the editor checks it and ticks Paid.

import sharp from 'sharp';
import { test, expect, serverOrigin, signInAsStaff, enterPassword, openSection } from './fixtures.js';
import { EVENTS, STAFF, MEMBER } from './seed.js';

const event = EVENTS.convention;
const SAVED = 'All changes saved';
const status = (page) => page.locator('#autosaveStatus');
const picture = (width, height) => sharp({ create: { width, height, channels: 3, background: '#224466' } }).png().toBuffer();

async function openEditor(page) {
  await page.goto('/login?next=/manage');
  await signInAsStaff(page, STAFF.username);
  await page.waitForURL(`${serverOrigin()}/manage`);
  await page.goto(`/manage?slug=${event.slug}#editor`);
  await expect(status(page)).toHaveText(SAVED);
}

test('an editor takes payment by QR code, a member pays and reports it, the editor ticks Paid', async ({ page, context }) => {
  // The editor: payment link ticked on a price range, so not offered yet.
  await openEditor(page);
  await openSection(page, 'Price and RSVP');
  const problems = page.locator('#paymentProblems li');
  await page.locator('#f-pay-link').check();
  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#paymentLinkField')).toBeVisible();
  await expect(problems).toHaveText([/needs one price to pay/, 'Paste the payment link to offer it.']);
  // One price, and the link: offered.
  await page.locator('#f-priceMax').fill('');
  await page.locator('#f-paymentLink').fill('https://pay.example.org/lion-city');
  await page.locator('#f-paymentInstructions').fill('Put your RSVP ID in the reference.');
  await page.locator('#f-paymentInstructions').blur();
  await expect(status(page)).toHaveText(SAVED);
  await expect(page.locator('#paymentProblems')).toBeHidden();
  // A QR code, tall and narrow, uploaded as it is.
  await page.locator('#f-pay-qr').check();
  await expect(problems).toHaveText(['Upload the QR code to offer it.']);
  await page.locator('#payQrFile').setInputFiles({ name: 'paynow.png', mimeType: 'image/png', buffer: await picture(300, 700) });
  await expect(page.locator('#payQrPreview')).toBeVisible();
  await expect(page.locator('#paymentProblems')).toBeHidden();
  await expect(status(page)).toHaveText(SAVED);

  // A member: "Get a ticket" on the event page, in place of "I am going".
  await context.clearCookies();
  await page.goto(`/e/${event.slug}`);
  await page.locator('#rsvpSignIn').click();
  await enterPassword(page, MEMBER.username);
  await page.waitForURL(`${serverOrigin()}/e/${event.slug}`);
  await expect(page.locator('#factPrice')).toContainText('Pay by: Payment link or QR code');
  await expect(page.locator('#rsvpBtn')).toBeHidden();
  const getTicket = page.locator('#rsvpCheckout');
  await expect(getTicket).toHaveText('Get a ticket');
  await getTicket.click();
  await page.waitForURL(`${serverOrigin()}/checkout?slug=${event.slug}`);

  // The order: one price, two ways to pay.
  await expect(page.locator('#checkoutTitle')).toHaveText(event.title);
  await expect(page.locator('#ticketList .choice-title')).toHaveText(['Ticket']);
  await expect(page.locator('#methodList .choice-title')).toHaveText(['Payment link', 'QR code']);
  await page.locator('#methodList').getByRole('radio', { name: /^QR code/ }).check();
  await expect(page.locator('#orderLines')).toContainText('Paying byQR code');
  await expect(page.locator('#reserveBtn')).toHaveText('Reserve my place');
  await page.locator('#reserveBtn').click();

  // The place is held: the QR code, the instructions, and the report.
  await expect(page.locator('#payStatusText')).toHaveText('Your place is held. Pay, then tell the organisers below.');
  await expect(page.locator('#payInstructions')).toHaveText('Put your RSVP ID in the reference.');
  await expect(page.locator('#payQr')).toBeVisible();
  expect(await page.locator('#payQr').evaluate((image) => image.naturalHeight > image.naturalWidth)).toBe(true);
  await expect(page.locator('#payLink')).toBeHidden();
  await page.locator('#payReference').fill('PAYNOW 8812');
  await page.locator('#payProof').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: await picture(600, 1200) });
  await expect(page.locator('#payProofName')).toHaveText('Screenshot ready to send.');
  await page.locator('#reportSubmit').click();
  await expect(page.locator('#payStatusText')).toHaveText(/^Payment sent\./);
  await expect(page.locator('#payProofName')).toHaveText('Screenshot sent.');

  // The event page says so too, and My events marks it.
  await page.goto(`/e/${event.slug}`);
  await expect(page.locator('#rsvpPaymentText')).toHaveText('Payment sent. The organisers will check it.');
  await page.goto('/account');
  await expect(page.locator('#rsvpUpcoming .event-card', { hasText: event.title }).locator('.chip-warn')).toHaveText('Payment being checked');

  // The editor: the payment to check, its screenshot, and Paid.
  await context.clearCookies();
  await openEditor(page);
  await openSection(page, 'Attendees and notes');
  await expect(page.locator('#attendeesPayments')).toHaveText('Payments: 1 to check');
  const row = page.locator('#attendeeList .attendee-row', { hasText: MEMBER.username });
  await expect(row).toContainText('QR code · To check · Ref PAYNOW 8812');
  await expect(row.getByRole('link', { name: /payment screenshot/ })).toHaveAttribute('href', /\/api\/manage\/payment-proof\?id=/);
  await row.locator('.attendee-paid input').check();
  await expect(page.locator('#attendeesPayments')).toHaveText('Payments: 1 paid');
  await expect(row).toContainText('QR code · Paid');
});
