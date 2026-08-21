# 7. الـCAPTCHA — موثق (London E2E 2026-08-21)

- أوراق أنماط BotDetect تُحمَّل في كل صفحة (`BotDetectCaptcha.ashx?get=layout-stylesheet`).
- **لم يُرصد أي حقل CAPTCHA في مسار الاكتشاف** (المكتب ← التصنيف ← العدد ← المعلومات ← شبكة الأسبوع).
- **موثق في مسار الحجز:** نموذج البيانات يحتوي `img#Captcha_CaptchaImage` (250×50, `BotDetectCaptcha.ashx?get=image&c=Captcha&t=...`) + `input#CaptchaText`/`name="CaptchaText"` + 4 حقول مخفية `BDC_VCID_Captcha`/`BDC_BackWorkaround_Captcha`/`BDC_Hs_Captcha`/`BDC_SP_Captcha` (scratchpad_hkcax71f). التحدي 4-char alphanumeric ديناميكي لكل جلسة — عينة موثقة `C65P` (ليست `C6SP`؛ الخلط S/5 يوضح خطر OCR المحلي). الخادم يتحقق منه مع الحقول BDC_*.
- **الحل المعتمد (open-source, D3 free-first):** `tesseract.js` 5.1.1 (Apache 2.0) عبر `src/captcha.ts` `solveCaptcha` — local OCR, PSM 8 single-word + whitelist `A-Z0-9`, no `CAPTCHA_API_KEY`, no polling, ~1-2s (vs 2captcha 10-60s), browser open time accordingly reduced (budget 600/540). بديل منصّي: Workers AI `env.AI` مع `@cf/llava` كنقطة واحدة. الفشل (`tesseract low confidence`) يُسجَّل `CAPTCHA solve failed` ويُعاد جدولة `ACTIVE+backoff`.

---
