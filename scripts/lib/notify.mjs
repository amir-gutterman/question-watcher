// Notification fan-out. Today there's only email (Gmail SMTP), but the
// shape is deliberately "one function per channel, called from a list" so
// adding Slack/Telegram/WhatsApp later means writing one new function and
// adding one line here - see README "Adding a new notification channel".

import nodemailer from "nodemailer";
import { EMAIL_SUBJECT, buildEmailHtml, buildEmailText } from "./emailTemplates.mjs";

async function sendEmail(updates, recipient) {
  if (!recipient) {
    console.warn(JSON.stringify({ event: "notify.email.skipped_no_recipient" }));
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_ADDRESS,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const fromName = process.env.EMAIL_FROM_NAME || "Question Watcher";

  await transporter.sendMail({
    from: `"${fromName}" <${process.env.GMAIL_ADDRESS}>`,
    to: recipient,
    subject: EMAIL_SUBJECT,
    html: buildEmailHtml(updates),
    text: buildEmailText(updates),
  });

  console.log(
    JSON.stringify({ event: "notify.email.sent", recipient, questionCount: updates.length }),
  );
}

/**
 * Sends `updates` to every configured channel. Each channel's failure is
 * logged and swallowed independently so one broken channel never blocks
 * another or fails the whole Action run.
 */
export async function notifyUpdates(updates, settings) {
  if (updates.length === 0) return;

  const channels = [{ name: "email", run: () => sendEmail(updates, settings.notifyEmail) }];
  // Future channels get added here, e.g.:
  //   if (settings.slackWebhookUrl) channels.push({ name: "slack", run: () => sendSlack(updates, settings.slackWebhookUrl) });

  await Promise.all(
    channels.map(async ({ name, run }) => {
      try {
        await run();
      } catch (err) {
        console.error(JSON.stringify({ event: "notify.channel_failed", channel: name, error: err.message }));
      }
    }),
  );
}
