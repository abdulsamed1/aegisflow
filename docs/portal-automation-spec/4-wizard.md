# 4. مسار المعالج (Wizard) — موثق خطوة بخطوة

النموذج من نوع WebForms: كل خطوة `POST /` بنفس الحقول المتراكمة + `Command`.

## خطوة 1 — اختيار المكتب
- `select#Office`: ~88 تمثيلية (منها `KAIRO`).
- زر `input[type=submit][name=Command][value=Next]`.

## خطوة 2 — اختيار التصنيف
- `select#CalendarId` (required) — التصنيفات المرصودة لقاهرة:

| التصنيف (نص القائمة الأصلي) | CalendarId |
|-----------------------------|------------|
| Aufenthaltsbewilligung Student (nur Bachelor) | **44281520** |
| Aufenthaltsbewilligung Student (nur Master, PhD und Stipendiate) | **44279679** |
| Aufenthaltstitel Rot-Weiß-Rot Karte | UNVERIFIED |
| Familienzusammenführung gem. NAG (ÄgypterInnen) | UNVERIFIED |
| Familienzusammenführung gem. NAG (sonstige Staatsangehörige) | UNVERIFIED |
| Österreicher Personenstandsangelegenheiten | UNVERIFIED |
| Österreicher (Reisepässe, Staatsbürgerschaft) | UNVERIFIED |
| Visum D zur Arbeitsuche (Job-Seeker) | UNVERIFIED |

- ملاحظة: نصوص التصنيفات تظهر بالألمانية حتى في الواجهة الإنجليزية.

## خطوة 3 — عدد الأشخاص
- `select#PersonCount`: لتصنيف الطلاب الخيار الوحيد `1`. (تقييد `1..100` في التحقق.)

## خطوة 4 — صفحة معلومات رسمية
- نص إلزامي يعرض متطلبات التصنيف (نموذج الطلب، قائمة المستندات، عنوان القنصلية بالزمالك). لقطة: `step4.png`.
- بدون أي حقول إدخال — زر Next فقط.

## خطوة 5 — شبكة الأسبوع (Scheduler)
- عنوان: `Appointments available for "<التصنيف>", 1 Person(s):`
- شريط أسبوع واحد: `Week <Mon> - <Sun>` مع زر `Week before` و`Back`.
- الشبكة نفسها جدول HTML ثانٍ داخل النموذج؛ عند عدم وجود مواعيد يكون **فارغًا** مع رسالة:
  `For your selection there are unfortunately no appointments available` (class `message-error`).
- القيمة الافتراضية المرسلة من الخادم وقت التوثيق: `Monday = 10/5/2026 12:00:00 AM`.
- زر `Week before` عند هذه القيمة **لا يغير الصفحة** (إعادة عرض نفس الأسبوع).
- النموذج يرسل إلى **`POST /HomeWeb/Scheduler`** — وهو أهم اكتشاف في هذا التوثيق (القسم التالي).

---
