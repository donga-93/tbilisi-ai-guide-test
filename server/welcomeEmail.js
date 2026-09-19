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

const CHECKOUT_URL = "https://cheerful-gnome-3af2aa.netlify.app/";

// TODO: შეცვალე ვერიფიცირებული საკუთარი დომენით, როგორც კი ის Resend-ში
// დადასტურდება — sandbox/onboarding დომენი (onboarding@resend.dev) მხოლოდ
// ტესტირებისთვისაა და შეზღუდულია (Resend-ის საკუთარი ანგარიშის
// ვერიფიცირებულ მისამართებზე ან ტესტ-რეჟიმზე).
const FROM_ADDRESS = "Georgia Travel AI Guide <onboarding@resend.dev>";

// ------------------------------------------------------------
// locale ტექსტების ჩატვირთვა — server/ დირექტორიის საკუთარი,
// თვითკმარი emailLocales.json-იდან (Railway მხოლოდ server/-ს
// დეპლოის, ამიტომ client-ის src/locales/-ზე დამოკიდებულება
// გამორიცხულია)
// ------------------------------------------------------------
const EMAIL_LOCALES = require("./emailLocales.json");

function loadLocaleTexts(locale) {
  const safeLocale = SUPPORTED_LOCALES.includes(locale) ? locale : "en";
  return EMAIL_LOCALES[safeLocale] || EMAIL_LOCALES.en;
}

function renderLink(template) {
  return typeof template === "string"
    ? template.replace(/\{link\}/g, CHECKOUT_URL)
    : template;
}

async function sendEmail(to, subject, body) {
  if (!process.env.RESEND_API_KEY) {
    return { success: false, error: "RESEND_API_KEY is not set" };
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to,
        subject,
        text: body,
      }),
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

// ============================================================
// Welcome email — POST /register-user-ის მიერ გამოძახებული,
// მხოლოდ users/{uid}.welcomeEmailSent !== true-ს შემთხვევაში
// ============================================================
async function sendWelcomeEmail(email, locale) {
  try {
    if (!email) {
      return { success: false, error: "Missing recipient email" };
    }

    const texts = loadLocaleTexts(locale);
    const subject = texts.welcomeEmailSubject;
    const body = renderLink(texts.welcomeEmailBody);

    if (!subject || !body) {
      return {
        success: false,
        error: "Missing welcome email texts for locale",
      };
    }

    return await sendEmail(email, subject, body);
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// Limit-reached email — 7 დღეში ერთხელ, throttle-ის უკან
// (იხ. auth.js-ის notifyLimitReachedForUid)
// ============================================================
async function sendLimitReachedEmail(email, locale) {
  try {
    if (!email) {
      return { success: false, error: "Missing recipient email" };
    }

    const texts = loadLocaleTexts(locale);
    const subject = texts.limitReachedEmailSubject;
    const body = renderLink(texts.limitReachedEmailBody);

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
