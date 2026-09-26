# 7. الـCAPTCHA — موثق (London E2E 2026-08-21، مُحدَّث 2026-08-22 KAIRO حي)

- أوراق أنماط BotDetect تُحمَّل في كل صفحة (`BotDetectCaptcha.ashx?get=layout-stylesheet`).
- **لم يُرصد أي حقل CAPTCHA في مسار الاكتشاف** (المكتب ← التصنيف ← العدد ← المعلومات ← شبكة الأسبوع).
- **موثق في مسار الحجز:** نموذج البيانات يحتوي `img#Captcha_CaptchaImage` (250×50, `BotDetectCaptcha.ashx?get=image&c=Captcha&t=...`) + `input#CaptchaText`/`name="CaptchaText"` + 4 حقول مخفية `BDC_VCID_Captcha`/`BDC_BackWorkaround_Captcha`/`BDC_Hs_Captcha`/`BDC_SP_Captcha` (scratchpad_hkcax71f). التحدي 4-char alphanumeric ديناميكي لكل جلسة — عينة موثقة `C65P`. الخادم يتحقق منه مع الحقول BDC_*.
- **زر الإرسال الصحيح للخطوة 6 هو `input#nextButton`** (قيمة Next/Save) — محدد `input[type=submit]` العام يضرب زر Back (موثق حياً 2026-08-22، KAIRO).

## القناة الصوتية — الاكتشاف الحاسم (2026-08-22, موثق حي على KAIRO)

BotDetect يعرض **تحدياً صوتياً** على نفس المعالج: `get=sound` بدل `get=image` → استجابة `audio/x-wav` ‏(PCM 16-bit mono 8kHz، ~4.9s، ~79KB) — حروف منطوقة منفصلة نظيفة. جُلِب بنجاح داخل سياق الصفحة (نفس كوكيز الجلسة) عبر `page.evaluate(fetch)` المزود بمؤقت `AbortController` (سقف 6 ثوانٍ) لمنع تعليق الجلسة عند بطء استجابة خادم السفارة.

## سلسلة الحل المعتمدة (`src/captcha.ts` + `src/browser-fallback.ts`)

1. **الصوت أولاً مع القطع السريع (OPT-7)** — `solveCaptchaAudio(wavBytes, ai)`: تشغيل متسلسل يبدأ بـ `@cf/openai/whisper-tiny-en` فائق السرعة (~300–600ms). عند إنتاج رمز صالح من 4–5 خانات، يتم **القطع فورًا وإرجاع الرمز** دون استدعاء الموديل الأكبر. في حال عدم الصلاحية أو الفشل، يتم التراجع تلقائيًا إلى `@cf/openai/whisper-large-v3-turbo`. التحليل عبر `parseAudioTranscription`: تنظيف فواصل + طي التكرارات المتتالية + سقف 6 خانات.
2. **سقف مهلة الجلب الصوتي**: في حال فشل أو تجاوز جلب ملف الصوت 6 ثوانٍ، يسقط الطلب فورًا دون تعليق المتصفح ويتراجع إلى مسار الصورة.
3. **احتياط الصورة** — `solveCaptcha(screenshotBase64, ai)`: التقاط لقطة شاشة لـ `img#Captcha_CaptchaImage` والحل عبر Workers AI `@cf/meta/llama-3.2-11b-vision-instruct` → REST → tesseract.js (PSM 7 + whitelist A-Z0-9).
4. **الفشل** → `isCaptchaError` يرصد الرفض ويعيد المحاولة (شبكة أمان).

## جرد Workers AI الموثق (حسب حساب المشغل 2026-08-22)

| الموديل | الحالة |
|---------|--------|
| `@cf/openai/whisper-tiny-en` / `whisper` / `whisper-large-v3-turbo` | ✅ تعمل على WAV — قرأت تحدي KAIRO صوتياً `"T, D, R, 5, 8."` (~1s REST) |
| `@cf/meta/llama-3.2-11b-vision-instruct` | ✅ متاح لكن ضعيف على BotDetect (0/3 حي) |
| `@cf/meta/llama-3.2-90b-vision-instruct` | ❌ غير موجود فعلياً — `7000 No route` (كان في الكود سابقاً وأُصلح) |
| `@cf/llava-hf/llava-1.5-7b-hf` | ❌ مخرجات غير صالحة ("JJJJ…") |
| `@cf/moondream/moondream3.1-9B-A2B` | ⚠️ موجود لكن توفره يتقلب (`Engine Not Ready` 429 عند الاختبار) |

## قياسات الدقة (خام)

- الصور: tesseract 0/5 (`scratch/failed-captchas`) و0/3 حي؛ 11b 0/3 حي — **سبب اعتماد الصوت أساساً**.
- الصوت: نسخ نظيف ملحوظ؛ محاولة E2E حية واحدة رُفضت لعدّ whisper 7 خانات بدل 4-5 (over-segmentation) — المحلل يطويها الآن؛ يلزم ≥10 جولات حية لقياس نسبة نجاح المحاولة الأولى (البوابة فرضت rate-limit أثناء القياس).
- الزمن: REST ~150ms–1.8s حسب الموديل؛ <100ms غير قابل للتحقيق لكنه غير مؤثر — جلسة الكابتشا تبقى صالحة أثناء الإرسال، والمطلوب دقة المحاولة الأولى.

## عينات محفوظة

`scratch/captcha-kairo-attempt{1..3}.png`, `scratch/audio-e2e-{1}.wav`, `scratch/captcha-sound.wav`, `scratch/failed-captchas/*` (الحقيقة بأسماء الملفات).

---
