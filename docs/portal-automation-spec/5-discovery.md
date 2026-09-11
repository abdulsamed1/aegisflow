# 5. ماسح التوافر (Discovery) — العقد الموثق

## الطلب

```text
POST https://appointment.bmeia.gv.at/HomeWeb/Scheduler
Content-Type: application/x-www-form-urlencoded

Language=en
Office=KAIRO
CalendarId=44281520
PersonCount=1
Monday=10/5/2026 12:00:00 AM
Command=Next
```

مع كوكيز: `AspxAutoDetectCookieSupport=1` + `ASP.NET_SessionId`.

## الاستجابة

| الخاصية | القيمة المرصودة |
|---------|-----------------|
| Status | 200, `text/html; charset=utf-8` |
| Cache-Control | `public, no-cache="Set-Cookie", no-store, max-age=0` — **كل فحص استجابة جديدة من الخادم** |
| الحجم | ~2.5KB |
| الزمن (5 قياسات) | 767ms (أول طلب) ثم 116–216ms، متوسط ~270ms |

## عقد التحليل (Detection Contract)

> **مُصحَّح 2026-08-22** بعد اكتشاف إنتاجي خطير على KAIRO cal=26425165 (موعد حقيقي `9/27/2026 9:00 AM`):
> صفحة **تحتوي مواعيد** تحمل `<p class="message-error">Please choose an appointment!</p>` — رسالة "اختر موعداً" وليست خطأ نفاد!
> العقد القديم ("أي message-error = لا مواعيد") كان يُصنّف كل تقويم مفتوح خطأً NO_SLOTS. أُصلح في `src/scanner.ts` مع اختبارَي regression من HTML حي (`test/edge-cases-and-failures.test.ts`).

1. إن وُجد نص `no appointments available` (بشكل غير حساس لحالة الأحرف Case-Insensitive، سواء ضمن message-error أو غيره، مثال موثق: "For your selection there are unfortunately no appointments available" من ANKARA 8983879 الفارغ فعلاً) → **لا مواعيد** (`NO_SLOTS`) لهذا الأسبوع.
2. إن وُجدت عناصر `input[type="radio"]` بقيمة موعد (`value="M/D/YYYY h:mm:ss AM/PM"`) أو مواعيد داخل شبكة الجدول → **توجد مواعيد** (`SLOTS`) → الالتقاط وفق القسم 8. هذه هي الإشارة الحاسمة الوحيدة للمواعيد، وتنبيه `<p class="message-error">Please choose an appointment!</p>` **لا يُعد إشارة سلبية** لنفاد المواعيد لأنه يظهر طبيعيًا في الصفحات المتاحة.
3. أي استجابة غير 200 أو بنية غير متوقعة بلا radios وبلا نص النفاد → `UNKNOWN` (لا قرار حجز مبني عليها، ولا تُعامل كمواعيد أبدًا). ومنذ 2026-09-11 يُوسم السبب (`ScanResult.errorKind`): `TRANSPORT` = لا استجابة HTTP صالحة (حالة غير 200 أو استثناء fetch — البوابة ساقطة/تحجب) مقابل `PARSE` = ردّ 200 ببنية غير متوقعة (البوابة ردّت).

### أدلة حية (2026-08-22)

| الحالة | الاستجابة | التصنيف الصحيح |
|--------|-----------|----------------|
| KAIRO 26425165 فيه موعد | len≈2992، `message-error`="Please choose an appointment!" + radio `9/27/2026 9:00:00 AM` | **SLOTS** |
| ANKARA 8983879 فارغ | len≈2508، `message-error`="…unfortunately no appointments available"، radios=0 | **NO_SLOTS** |
| انتهاء مهلة البوابة | fetch timeout / len=0 | **UNKNOWN** (رُصد 9/28/2026 أثناء ضغط الاختبار) |
| عاصفة 520 (2026-09-01→11، ~5.8k صف) | `HTTP 520` فارغ × كل الأسابيع | **UNKNOWN + TRANSPORT** — أول دفعة توثّق الانقطاع، ثم تُتخطى الـbursts المتبقية (صف `UNKNOWN_RESPONSE` مجمّع واحد بدل ~8 صفوف لكل دفعة + تخطي انتظار 30s) |

### ترشيد الانقطاع (2026-09-11)

- عندما تفشل الدفعة كاملة على مستوى النقل (`isTransportOutage`: كل النتائج `UNKNOWN+TRANSPORT` بلا أي `SLOTS`/`NO_SLOTS`/`PARSE`) يستحيل أن تنجح الدفعات المتبقية، فتُتخطى مع انتظارها. أي ردّ من البوابة — حتى `PARSE` غريب — يعني أنها حيّة فيُستأنف الفحص طبيعيًا. `jobs.last_error_code` يُحدَّث كالمعتاد فلا تضيع الرؤية.

## قواعد Monday

- الخادم يقبل **أي** `Monday` يرسله العميل (اختُبر `10/12/2026` وأعيدت كما هي).
- `Monday` يُحسب: بداية أسبوع (الاثنين) — يستحسن توليده من `الاثنين 00:00` بأي توقيت (نفس تنسيق `M/d/yyyy h:mm:ss tt`).
- حدود المستقبل المسموح (إلى أي أسبوع يقبل الخادم مواعيد فعلية) UNVERIFIED — يُقاس عند أول أسبوع يعرض مواعيد.

## أثر السرعة على ميزانية المتصفح

- الفحص الواحد ~0.3–0.8 ثانية متصفح → حدود الـ10 دقائق/يوم المجانية تسع نظريًا **~750–2000 فحص/يوم**، والسقف العملي هو الأخلاقيات ومعدل 429 وعدد المتصفحات المتزامنة (3)، لا الميزانية نفسها. (يعاير أرقام الـbrief القسم 10.)

---
