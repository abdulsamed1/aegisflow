# 6. مسار الحجز (Booking Path) — Playwright Wizard (revised 2026-08-21)

- **المسار الوحيد الحقيقي (Playwright Wizard)**: بعد اكتشاف موعد (`SLOTS`) وإعادة التحقق من الشبكة قبل الإطلاق، يفتح `executePlaywrightFallback` متصفحًا ويمر بالمعالج الكامل: Office=KAIRO → CalendarId → PersonCount=1 → صفحة المعلومات → شبكة الأسبوع (Radios: 10:00/10:30/11:00/11:30 — London evidence Wed 8/26) → اختيار الموعد → نموذج البيانات بـ31 حقلًا حقيقيًا (Lastname/Firstname/DateOfBirth/TraveldocumentNumber/Sex/Postcode/Telephone/DSGVOAccepted …) + حقول BDC_* المخفية + `CaptchaText` محلولًا محليًا عبر `tesseract.js` (C65P عينة، 4-char ديناميكي، لا CAPTCHA_API_KEY) → Submit → تحليل `GESX-...`. النجاح فقط عند وجود المرجع، مع حد 20 ثانية بين الإطلاقات (NFR-2).
- **الاكتشاف يبقى HTTP**: الفحص عبر `POST /HomeWeb/Scheduler` مع `Monday` (8-weeks rolling) — العقد الموثق الوحيد (G0 §5). لا يوجد POST مباشر للحجز بمعامل `AppointmentDate` مفبرك أو `CaptchaText=AUTO` بعد الآن.
- **تأكيد الحجز واستخراج المرجع**: يتم استخراج مرجع الحجز الفعلي (`GESX-...` عبر `parseBookingConfirmationReference`) من محتوى الصفحة النهائية وتسجيله فورًا مع إغلاق قفل الـDO (`/seal`) وإرسال إشعار تلغرام. الفشل يعاد فحص الشبكة ويعاد المحاولة مرة واحدة فقط قبل `ACTIVE+backoff`.

---
