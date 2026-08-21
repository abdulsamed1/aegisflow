# 6. مسار الحجز (Booking Path) — Playwright Wizard (revised 2026-08-21)

- **المسار الوحيد الحقيقي (Playwright Wizard)**: بعد اكتشاف موعد (`SLOTS` — انظر تصحيح عقد الكشف في §5 بتاريخ 2026-08-22: صفحة المواعيد نفسها تحمل message-error "Please choose an appointment!") وإعادة التحقق من الشبكة قبل الإطلاق، يفتح `executePlaywrightFallback` متصفحًا ويمر بالمعالج الكامل: Office=KAIRO → CalendarId → PersonCount=1 → صفحة المعلومات → شبكة الأسبوع (Radios) → اختيار الموعد → نموذج البيانات بـ31 حقلًا حقيقيًا + حقول BDC_* المخفية + `CaptchaText` محلولاً **صوتيًا أولاً** (`get=sound` → Whisper — موثق 2026-08-22، KAIRO حي) مع احتياط صورة (11b→REST→tesseract.js)، لا CAPTCHA_API_KEY → Submit عبر `input#nextButton` (موثق حياً — المحدد العام يضرب Back) → تحليل `GESX-...`. النجاح فقط عند وجود المرجع، مع حد 20 ثانية بين الإطلاقات (NFR-2).
- **الاكتشاف يبقى HTTP**: الفحص عبر `POST /HomeWeb/Scheduler` مع `Monday` (8-weeks rolling) — العقد الموثق الوحيد (G0 §5). لا يوجد POST مباشر للحجز بمعامل `AppointmentDate` مفبرك أو `CaptchaText=AUTO` بعد الآن.
- **تأكيد الحجز واستخراج المرجع**: يتم استخراج مرجع الحجز الفعلي (`GESX-...` عبر `parseBookingConfirmationReference`) من محتوى الصفحة النهائية وتسجيله فورًا مع إغلاق قفل الـDO (`/seal`) وإرسال إشعار تلغرام. الفشل يعاد فحص الشبكة ويعاد المحاولة مرة واحدة فقط قبل `ACTIVE+backoff`.

---
