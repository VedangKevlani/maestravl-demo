import { Resend } from 'resend'
import { formatMonitoringStatus } from './monitoring/format'
import { formatDuration, formatTime } from './agents/message'
import { formatFriendlyTime } from './dateFormat'
import { wrapEmail, emailHeading, emailCallout, emailButton, formatMessageBodyHtml, escapeHtml } from './emailTemplate'

const resend = new Resend(process.env.RESEND_API_KEY)

// maestravl.com is verified with Resend as of 2026-09 — real delivery to
// any recipient, not just the Resend account's own inbox (see
// docs/DATA_SOURCES.md for why that was ever a constraint). Still the
// fallback, not a hardcoded default, so EMAIL_FROM in .env/Vercel remains
// the actual source of truth.
const DEFAULT_FROM = 'Maestravl <notifications@maestravl.com>'

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  const from = process.env.EMAIL_FROM ?? DEFAULT_FROM

  const html = wrapEmail({
    preheader: 'Reset your Maestravl password',
    bodyHtml: `
      ${emailHeading('Reset your password')}
      <p style="margin:0 0 12px;">Someone requested a password reset for this account. If that was you, use the button below — this link expires in <strong>1 hour</strong>.</p>
      ${emailButton(resetUrl, 'Reset password')}
      <p style="margin:20px 0 0; font-size:12.5px; color:#8b8f96;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
    `,
  })

  const { error } = await resend.emails.send({
    from,
    to,
    subject: 'Reset your Maestravl password',
    html,
  })

  if (error) throw new Error(error.message)
}

export async function sendPassengerAddedEmail(
  to: string,
  opts: {
    recipientName: string
    tripTitle: string
    segments: { label: string; departureTime: Date | null; timezone: string | null }[]
  }
) {
  const from = process.env.EMAIL_FROM ?? DEFAULT_FROM
  const subject = `You're on ${opts.tripTitle}`

  const itineraryHtml = opts.segments.length
    ? `<ul style="margin:0 0 4px; padding-left:20px;">${opts.segments
        .map((s) => `<li style="margin-bottom:6px;">${escapeHtml(s.label)}${s.departureTime ? ` — ${escapeHtml(formatFriendlyTime(s.departureTime, s.timezone))}` : ''}</li>`)
        .join('')}</ul>`
    : `<p style="margin:0 0 4px; color:#8b8f96;">No segments have been added to this trip yet — you'll see them here once they are.</p>`

  const html = wrapEmail({
    preheader: `You've been added to ${opts.tripTitle}`,
    bodyHtml: `
      ${emailHeading(`You're on ${opts.tripTitle}`)}
      <p style="margin:0 0 14px;">Hi ${escapeHtml(opts.recipientName)}, you've been added as a passenger on <strong>${escapeHtml(opts.tripTitle)}</strong>. Here's the current itinerary:</p>
      ${itineraryHtml}
      <p style="margin:16px 0 0; font-size:13px; color:#8b8f96;">Maestravl will email you here if anything on this trip changes.</p>
    `,
  })

  const { error } = await resend.emails.send({ from, to, subject, html })

  if (error) throw new Error(error.message)
  return subject
}

export async function sendStatusChangeEmail(
  to: string,
  opts: { recipientName: string; segmentLabel: string; tripTitle: string; previousStatus: string | null; newStatus: string }
) {
  const from = process.env.EMAIL_FROM ?? DEFAULT_FROM
  const newLabel = formatMonitoringStatus(opts.newStatus)
  const subject = `${opts.segmentLabel} is now ${newLabel}`

  const html = wrapEmail({
    preheader: subject,
    bodyHtml: `
      ${emailHeading(subject)}
      <p style="margin:0 0 14px;">Hi ${escapeHtml(opts.recipientName)}, <strong>${escapeHtml(opts.segmentLabel)}</strong> (${escapeHtml(opts.tripTitle)}) ${opts.previousStatus ? `changed from ${escapeHtml(formatMonitoringStatus(opts.previousStatus))} to` : 'is now'} <strong>${escapeHtml(newLabel)}</strong>.</p>
      <p style="margin:0; font-size:13px; color:#8b8f96;">Maestravl is watching this for you and will keep you posted on anything else that changes.</p>
    `,
  })

  const { error } = await resend.emails.send({ from, to, subject, html })

  if (error) throw new Error(error.message)
  return subject
}

/** Sent when a disruption's impact analysis finds other segments on the trip that may be affected — see lib/agents/analyze.ts. Only sent when there's something to report; a disruption with no downstream impact just gets the plain sendStatusChangeEmail above. */
export async function sendDisruptionImpactEmail(
  to: string,
  opts: {
    recipientName: string
    tripTitle: string
    disruptedSegmentLabel: string
    newStatus: string
    delayMinutes: number | null
    /** The disrupted segment's own new departure time, when known — shown alongside the delay duration so the passenger sees an actual time, not just a minute count. */
    newDepartureTime: Date | null
    /** The disrupted segment's own timezone — see lib/agents/message.ts's formatTime for why this must never fall back to the server's incidental local zone. */
    timezone: string | null
    /**
     * `contacted: true` means Maestravl actually sent a request to this
     * provider — false means either nothing usable was found, or
     * (`awaitingApproval: true`) something *was* found and is waiting on
     * the passenger's own OK in the app before anything is sent (see
     * lib/agents/orchestrator.ts's draftContactRequest — contacting a real
     * business is never done on Maestravl's own judgment alone).
     * `fallbackContact` — when set on an uncontacted, non-pending item — is
     * a phone number, web form, or portal URL found but not something
     * Maestravl can act on automatically.
     */
    affected: { label: string; reason: string; contacted: boolean; fallbackContact?: { channel: string; value: string } | null; awaitingApproval?: boolean }[]
  }
) {
  const from = process.env.EMAIL_FROM ?? DEFAULT_FROM
  const newLabel = formatMonitoringStatus(opts.newStatus)
  const contactedCount = opts.affected.filter((a) => a.contacted).length
  const awaitingCount = opts.affected.filter((a) => a.awaitingApproval).length
  const subject = `${opts.tripTitle}: ${opts.affected.length} other reservation${opts.affected.length === 1 ? '' : 's'} may need attention`

  const delayPhrase = opts.delayMinutes
    ? ` — about ${formatDuration(opts.delayMinutes)} late${
        opts.newDepartureTime ? `, now expected around ${formatTime(opts.newDepartureTime, opts.timezone)}` : ''
      }`
    : ''

  const affectedHtml = opts.affected
    .map((a) => {
      const followUp = a.contacted
        ? "We've reached out to request a change and are waiting to hear back."
        : a.awaitingApproval
          ? 'We found a contact for them and are waiting for your OK in the app before reaching out.'
          : a.fallbackContact
            ? `We couldn't contact them automatically, but found a ${escapeHtml(a.fallbackContact.channel.toLowerCase())} contact: ${escapeHtml(a.fallbackContact.value)} — you may want to reach out directly.`
            : "We couldn't find a way to contact them automatically — you may want to confirm directly with them for now."
      return `<li style="margin-bottom:8px;"><strong>${escapeHtml(a.label)}</strong> — ${escapeHtml(a.reason)} ${followUp}</li>`
    })
    .join('')

  const html = wrapEmail({
    preheader: subject,
    bodyHtml: `
      ${emailHeading(`${escapeHtml(opts.disruptedSegmentLabel)} is now ${escapeHtml(newLabel)}`)}
      <p style="margin:0 0 14px;">Hi ${escapeHtml(opts.recipientName)}, <strong>${escapeHtml(opts.disruptedSegmentLabel)}</strong> (${escapeHtml(opts.tripTitle)}) is now <strong>${escapeHtml(newLabel)}</strong>${delayPhrase}. Here's what that means for the rest of your trip:</p>
      <ul style="margin:0 0 4px; padding-left:20px;">${affectedHtml}</ul>
      ${
        awaitingCount > 0
          ? emailCallout({ tone: 'amber', html: `<strong>${awaitingCount} contact${awaitingCount === 1 ? '' : 's'} found, waiting on you.</strong> Open the app to review and approve before Maestravl reaches out.` })
          : ''
      }
      <p style="margin:16px 0 0; font-size:13px; color:#8b8f96;">${
        contactedCount > 0
          ? "We'll let you know as soon as we hear back."
          : "We'll keep watching and let you know if anything changes."
      }</p>
    `,
  })

  const { error } = await resend.emails.send({ from, to, subject, html })

  if (error) throw new Error(error.message)
  return subject
}

/** Sent once the passenger confirms a provider-agreed reschedule — the itinerary actually changed, so everyone on the trip should hear the new times, not just the person who clicked Confirm. */
export async function sendItineraryUpdatedEmail(
  to: string,
  opts: {
    recipientName: string
    tripTitle: string
    changes: { label: string; oldTime: Date | null; newTime: Date; timezone: string | null }[]
  }
) {
  const from = process.env.EMAIL_FROM ?? DEFAULT_FROM
  const subject = `${opts.tripTitle}: itinerary updated`

  const changesHtml = opts.changes
    .map(
      (c) =>
        `<li style="margin-bottom:8px;"><strong>${escapeHtml(c.label)}</strong> — now ${escapeHtml(formatFriendlyTime(c.newTime, c.timezone))}${
          c.oldTime ? ` <span style="color:#8b8f96;">(was ${escapeHtml(formatFriendlyTime(c.oldTime, c.timezone))})</span>` : ''
        }</li>`
    )
    .join('')

  const html = wrapEmail({
    preheader: subject,
    bodyHtml: `
      ${emailHeading(subject)}
      <p style="margin:0 0 14px;">Hi ${escapeHtml(opts.recipientName)}, the provider confirmed a new time and <strong>${escapeHtml(opts.tripTitle)}</strong> has been updated:</p>
      <ul style="margin:0 0 4px; padding-left:20px;">${changesHtml}</ul>
      <p style="margin:16px 0 0; font-size:13px; color:#8b8f96;">Maestravl is still watching the rest of your trip and will let you know if anything else changes.</p>
    `,
  })

  const { error } = await resend.emails.send({ from, to, subject, html })

  if (error) throw new Error(error.message)
  return subject
}

/**
 * Sends an agent-composed message to a provider on the passenger's behalf
 * (see lib/agents/message.ts for the templates and lib/agents/orchestrator.ts
 * for what calls this — via approveContact.ts specifically, only after the
 * passenger has explicitly approved reaching out). Unlike the
 * passenger-facing emails above, the body is free text assembled at request
 * time; formatMessageBodyHtml renders its "Label:\nValue" convention as
 * real structure without touching the pure composer functions themselves.
 *
 * `replyTo`, when given, is the per-Communication address from
 * lib/inboundReplyAddress.ts — when the provider hits "Reply" in their
 * email client, their message goes there instead of the From address,
 * which is how app/api/webhooks/resend-inbound matches it back to this
 * exact conversation. Omitted when RESEND_INBOUND_DOMAIN isn't configured,
 * so an unconfigured deployment just doesn't advertise an address nothing
 * is listening on.
 */
export async function sendProviderEmail(to: string, subject: string, textBody: string, replyTo?: string) {
  const from = process.env.EMAIL_FROM ?? DEFAULT_FROM
  const html = wrapEmail({
    preheader: subject,
    bodyHtml: `
      ${emailHeading(subject)}
      ${formatMessageBodyHtml(textBody)}
    `,
  })

  const { error } = await resend.emails.send({
    from,
    to,
    subject,
    html,
    text: textBody,
    ...(replyTo ? { replyTo } : {}),
  })
  if (error) throw new Error(error.message)
}

export interface ReceivedEmail {
  id: string
  from: string
  to: string[]
  subject: string
  text: string | null
  html: string | null
}

/**
 * Fetches the full content of an inbound email by id — the
 * `email.received` webhook payload only carries metadata (from/to/subject),
 * not the body, per Resend's docs. Returns null on any failure (missing
 * key, API error, network failure) rather than throwing, since the caller
 * (the inbound webhook handler) always has a safe fallback: log what it
 * has and move on, never fabricate the reply's content.
 */
export async function fetchReceivedEmail(emailId: string): Promise<ReceivedEmail | null> {
  if (!process.env.RESEND_API_KEY) return null

  try {
    const { data } = await resend.emails.receiving.get(emailId)
    if (!data) return null
    return {
      id: data.id,
      from: data.from,
      to: data.to,
      subject: data.subject,
      text: data.text,
      html: data.html,
    }
  } catch {
    return null
  }
}
