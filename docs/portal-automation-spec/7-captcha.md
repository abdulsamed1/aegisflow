# 7. الـCAPTCHA — موثق (London E2E 2026-08-21)

- أوراق أنماط BotDetect تُحمَّل في كل صفحة (`BotDetectCaptcha.ashx?get=layout-stylesheet`).
- **لم يُرصد أي حقل CAPTCHA في مسار الاكتشاف** (المكتب ← التصنيف ← العدد ← المعلومات ← شبكة الأسبوع).
- **موثق في مسار الحجز:** نموذج البيانات يحتوي `img#Captcha_CaptchaImage` (250×50, `BotDetectCaptcha.ashx?get=image&c=Captcha&t=...`) + `input#CaptchaText`/`name="CaptchaText"` + 4 حقول مخفية `BDC_VCID_Captcha`/`BDC_BackWorkaround_Captcha`/`BDC_Hs_Captcha`/`BDC_SP_Captcha` (scratchpad_hkcax71f). التحدي 4-char alphanumeric ديناميكي لكل جلسة — عينة موثقة `C65P` (ليست `C6SP`؛ الخلط S/5 يوضح خطر OCR المحلي). الخادم يتحقق منه مع الحقول BDC_*.
- **الحل المعتمد:** خدمة خارجية 2captcha عبر `src/captcha.ts` (`solveCaptcha` + poll) بمفتاح `CAPTCHA_API_KEY` (wrangler secret). الفشل/الـtimeout يعني إحباط الحجز مع تسجيل `CAPTCHA solve failed` وإعادة الجدولة.

---
