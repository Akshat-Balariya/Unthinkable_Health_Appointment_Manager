import { env } from '../../config/env.js';

/**
 * Email templates.
 *
 * Every template returns BOTH html and text. The text alternative is not
 * decoration: some clients render it by preference, and a medication reminder
 * that arrives with an empty body is worse than none at all.
 *
 * Templates are pure functions of the stored payload and never touch the
 * database, so an email rendered from an outbox row two days late says exactly
 * what it would have said when the event happened.
 */

const escape = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function layout({ title, intro, rows = [], body = '', cta = null, footer = '' }) {
  const rowsHtml = rows.length
    ? `<table style="width:100%;border-collapse:collapse;margin:16px 0">${rows
        .map(
          ([k, v]) =>
            `<tr><td style="padding:6px 12px 6px 0;color:#666;vertical-align:top;white-space:nowrap">${escape(
              k
            )}</td><td style="padding:6px 0;color:#111"><strong>${escape(v)}</strong></td></tr>`
        )
        .join('')}</table>`
    : '';

  const ctaHtml = cta
    ? `<p style="margin:24px 0"><a href="${escape(cta.url)}" style="background:#1a56db;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escape(cta.label)}</a></p>`
    : '';

  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;padding:28px">
<h1 style="margin:0 0 12px;font-size:19px;color:#111">${escape(title)}</h1>
<p style="margin:0 0 8px;color:#333;line-height:1.55">${escape(intro)}</p>
${rowsHtml}${body}${ctaHtml}
<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.5">${escape(footer || env.MAIL_FROM_NAME)}</p>
</div></body></html>`;
}

function textify({ title, intro, rows = [], lines = [], footer = '' }) {
  return [
    title,
    '='.repeat(title.length),
    '',
    intro,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(lines.length ? ['', ...lines] : []),
    '',
    footer || env.MAIL_FROM_NAME,
  ].join('\n');
}

const bullets = (items) =>
  items.length
    ? `<ul style="margin:12px 0;padding-left:20px;color:#333;line-height:1.6">${items
        .map((i) => `<li>${escape(i)}</li>`)
        .join('')}</ul>`
    : '';

const note = (text) => `<p style="margin:12px 0;color:#555">${escape(text)}</p>`;

// ---------------------------------------------------------------------------

const TEMPLATES = {
  BOOKING_CONFIRMATION(p) {
    // Doctor and patient share this type; the doctor's payload carries symptoms.
    const forDoctor = Boolean(p.symptomsPreview);
    const title = forDoctor ? 'New appointment booked' : 'Your appointment is confirmed';
    const intro = forDoctor
      ? `${p.patientName} has booked an appointment with you.`
      : `Your appointment with ${p.doctorName} is confirmed.`;

    const rows = [
      ['When', p.when],
      !forDoctor && p.doctorName ? ['Doctor', p.doctorName] : null,
      !forDoctor && p.specialisation ? ['Specialisation', p.specialisation] : null,
      forDoctor && p.patientName ? ['Patient', p.patientName] : null,
    ].filter(Boolean);

    const body = forDoctor
      ? `<p style="margin:12px 0;color:#333"><strong>Reported symptoms:</strong><br>${escape(p.symptomsPreview)}</p>`
      : note(
          'Please arrive 10 minutes early. If you cannot attend, cancel in advance so the slot can be offered to someone else.'
        );

    return {
      html: layout({ title, intro, rows, body }),
      text: textify({
        title,
        intro,
        rows,
        lines: forDoctor ? [`Reported symptoms: ${p.symptomsPreview}`] : [],
      }),
    };
  },

  APPOINTMENT_REMINDER(p) {
    const title = 'Appointment reminder';
    const intro = `This is a reminder of your appointment with ${p.doctorName}.`;
    const rows = [
      ['When', p.when],
      ['Doctor', p.doctorName],
    ];
    return {
      html: layout({
        title,
        intro,
        rows,
        body: note('If you can no longer attend, please cancel so the slot can be released.'),
      }),
      text: textify({ title, intro, rows }),
    };
  },

  CANCELLATION(p) {
    const who =
      p.cancelledBy === 'PATIENT'
        ? 'the patient'
        : p.cancelledBy === 'DOCTOR'
          ? 'the doctor'
          : 'the clinic';
    const title = 'Appointment cancelled';
    const intro = `This appointment has been cancelled by ${who}.`;
    const rows = [
      ['When', p.when],
      p.doctorName ? ['Doctor', p.doctorName] : null,
      p.patientName ? ['Patient', p.patientName] : null,
      p.reason ? ['Reason', p.reason] : null,
    ].filter(Boolean);
    return { html: layout({ title, intro, rows }), text: textify({ title, intro, rows }) };
  },

  RESCHEDULE(p) {
    const title = 'Appointment rescheduled';
    const intro = 'This appointment has moved to a new time.';
    const rows = [
      ['Previously', p.oldWhen],
      ['Now', p.when],
      p.doctorName ? ['Doctor', p.doctorName] : null,
      p.patientName ? ['Patient', p.patientName] : null,
    ].filter(Boolean);
    return { html: layout({ title, intro, rows }), text: textify({ title, intro, rows }) };
  },

  LEAVE_CANCELLATION(p) {
    // Two shapes share this type: the doctor digest, and the patient notice.
    if (p.cancelledCount !== undefined) {
      const title = 'Your leave cancelled scheduled appointments';
      const intro = `${p.cancelledCount} appointment(s) were cancelled because you are marked unavailable.`;
      const items = (p.appointments ?? []).map((a) => `${a.when} - ${a.patientName}`);
      return {
        html: layout({ title, intro, body: bullets(items) }),
        text: textify({ title, intro, lines: items.map((i) => `- ${i}`) }),
      };
    }

    const title = 'Your appointment has been cancelled';
    const intro = `We are sorry - ${p.doctorName} is unavailable, so your appointment has been cancelled.`;
    const rows = [
      ['Was scheduled', p.when],
      ['Doctor', p.doctorName],
      p.reason ? ['Reason', p.reason] : null,
    ].filter(Boolean);
    return {
      html: layout({
        title,
        intro,
        rows,
        body: note('Please book another time at your convenience. We apologise for the inconvenience.'),
        cta: { label: 'Book another appointment', url: `${env.CLIENT_BASE_URL}/patient/doctors` },
      }),
      text: textify({
        title,
        intro,
        rows,
        lines: [`Book another appointment: ${env.CLIENT_BASE_URL}/patient/doctors`],
      }),
    };
  },
};

TEMPLATES.MEDICATION_REMINDER = (p) => {
  const title = 'Time for your medication';
  const intro = `Reminder to take ${p.medicationName}${p.dosage ? ` (${p.dosage})` : ''}.`;
  const rows = [
    ['Medication', p.medicationName],
    p.dosage ? ['Dose', p.dosage] : null,
    p.instructions ? ['Instructions', p.instructions] : null,
    p.doseNumber && p.totalDoses ? ['Progress', `dose ${p.doseNumber} of ${p.totalDoses}`] : null,
  ].filter(Boolean);

  const disclaimer =
    'Automated reminder based on your prescription. Speak to your doctor before ' +
    'changing how you take any medication.';

  return {
    html: layout({ title, intro, rows, footer: disclaimer }),
    text: textify({ title, intro, rows, footer: disclaimer }),
  };
};

TEMPLATES.POST_VISIT_SUMMARY_READY = (p) => {
  const title = 'Your visit summary is ready';
  const intro = `${p.doctorName ?? 'Your doctor'} has written up your recent visit.`;
  return {
    html: layout({
      title,
      intro,
      cta: { label: 'View your summary', url: `${env.CLIENT_BASE_URL}/patient/appointments` },
    }),
    text: textify({
      title,
      intro,
      lines: [`View it here: ${env.CLIENT_BASE_URL}/patient/appointments`],
    }),
  };
};

TEMPLATES.WELCOME = (p) => {
  const title = 'Welcome to the clinic';
  const intro = `Hello ${p.fullName ?? 'there'}, your account is ready.`;
  return { html: layout({ title, intro }), text: textify({ title, intro }) };
};

/**
 * Renders a notification.
 *
 * An unknown type falls back to a generic body rather than throwing: a missing
 * template is a deployment gap, and it should not strand a real row as
 * permanently DEAD when the recipient could still be told something.
 */
export function renderNotification(type, payload = {}) {
  const template = TEMPLATES[type];
  if (!template) {
    const title = 'Notification from the clinic';
    const intro = 'You have an update regarding your care.';
    return { html: layout({ title, intro }), text: textify({ title, intro }) };
  }
  return template(payload);
}

export const templateExists = (type) => Boolean(TEMPLATES[type]);
export const knownTemplates = () => Object.keys(TEMPLATES);
