// ============================================================
// Resend-ით გაგზავნილი ტრანზაქციული email-ები:
//   - sendWelcomeEmail        — რეგისტრაციის შემდეგ, ერთხელ (POST /register-user)
//   - sendLimitReachedEmail   — დღიური ლიმიტის ამოწურვისას (POST /notify-limit-reached,
//                               ან ხმოვანი quota-ს ამოწურვისას პირდაპირ auth.js-იდან)
//
// ორივე ფუნქცია არასდროს isვრის exception-ს — ყოველთვის აბრუნებს
// { success: true } ან { success: false, error }, რომ გამომძახებელმა
// (server.js/auth.js) არასდროს დაჭირდეს დამატებითი try/catch.
// ============================================================

const { buildWelcomeEmailHtml } = require("./welcomeEmailHtml");

const SUPPORTED_LOCALES = [
  "ka",
  "en",
  "ru",
  "tr",
  "zh",
  "ko",
  "de",
  "fr",
  "es",
  "it",
  "ja",
];

const RESEND_API_URL = "https://api.resend.com/emails";

const CHECKOUT_URL = "https://georgiatravelaiguide.com";

const FROM_ADDRESS = "Georgia Travel AI Guide <no-reply@georgiatravelaiguide.com>";

const REPLY_TO_ADDRESS = "support@georgiatravelaiguide.com";

const EMAIL_LOCALES = require("./emailLocales.json");

function loadLocaleTexts(locale) {
  const safeLocale = SUPPORTED_LOCALES.includes(locale) ? locale : "en";
  return EMAIL_LOCALES[safeLocale] || EMAIL_LOCALES.en;
}

// checkout საიტი URL-იდან კითხულობს ?email= და ?uid= პარამეტრებს
function buildCheckoutUrl(to, uid) {
  let url = `${CHECKOUT_URL}/?email=${encodeURIComponent(to)}`;
  if (uid) {
    url += `&uid=${encodeURIComponent(uid)}`;
  }
  return url;
}

function renderLink(template, link) {
  return typeof template === "string"
    ? template.replace(/\{link\}/g, () => link)
    : template;
}

async function sendEmail(to, subject, body, html) {
  if (!process.env.RESEND_API_KEY) {
    return { success: false, error: "RESEND_API_KEY is not set" };
  }

  try {
    const payload = {
      from: FROM_ADDRESS,
      reply_to: REPLY_TO_ADDRESS,
      to,
      subject,
      text: body,
    };

    if (html) {
      payload.html = html;
    }

    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      return {
        success: false,
        error: `Resend API error: ${response.status} ${errorBody}`,
      };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function sendWelcomeEmail(email, locale, uid) {
  try {
    if (!email) {
      return { success: false, error: "Missing recipient email" };
    }

    const texts = loadLocaleTexts(locale);
    const link = buildCheckoutUrl(email, uid);
    const subject = texts.welcomeEmailSubject;
    const body = renderLink(texts.welcomeEmailBody, link);

    if (!subject || !body) {
      return {
        success: false,
        error: "Missing welcome email texts for locale",
      };
    }

    let html;
    try {
      // href ატრიბუტში & უნდა იყოს escape-ებული
      html = buildWelcomeEmailHtml(texts, link.replace(/&/g, "&amp;"));
    } catch (htmlError) {
      html = undefined;
    }

    return await sendEmail(email, subject, body, html);
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function sendLimitReachedEmail(email, locale, uid) {
  try {
    if (!email) {
      return { success: false, error: "Missing recipient email" };
    }

    const texts = loadLocaleTexts(locale);
    const link = buildCheckoutUrl(email, uid);
    const subject = texts.limitReachedEmailSubject;
    const body = renderLink(texts.limitReachedEmailBody, link);

    if (!subject || !body) {
      return {
        success: false,
        error: "Missing limit-reached email texts for locale",
      };
    }

    return await sendEmail(email, subject, body);
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = { sendWelcomeEmail, sendLimitReachedEmail };
