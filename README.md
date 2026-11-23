# Personal DB

A Chrome extension that captures patient data from health-information-system pages and from local files into one simple, local database. You can then reuse that data to fill forms on other sites, or export it for your own analysis.

- **Local first.** Data lives in the browser (IndexedDB) on your computer.
- **Leaving your computer:** only two optional features send anything:
  - an **encrypted** Google Drive backup;
  - **AI extract**, which is opt-in and privacy-masked, and you review every request.
- **Nothing is saved or typed without a preview.**

## The data format: 5 fields

Every value is one row:

| patientId | label | value | time | source |
|---|---|---|---|---|
| N123456789 | Name | 王小明 | nan | https://hospital.gov |
| N123456789 | Blood pressure | 144/100 | 202601010600 | https://clinicA |
| N123456789 | Blood glucose (HS) | 107 | 202610241445 | https://ltc.example |
| N123456789 | Medication | Acetaminophen 500 mg; 1 粒; TID; 口服; 56天; 2026-10-07~2026-12-02; 小港醫院 骨科一診; 醫師甲 | 202610070900 | https://ltc.example |
| N123456789 | Photo | sha256:9f2c… | 202601010615 | https://clinicA |

**patientId**
- The national ID when the page shows one, because it is the same in every system.
- Otherwise the extension uses the record number (MRN) it already saved for that site.
- Failing that, it suggests a match by name plus birth date, or you type the ID yourself.

**label**
- A canonical label from the vocabulary in [extension/lib/schema.js](extension/lib/schema.js). For example, `姓名`, `個案姓名` and `Name` all become `Name`.
- A label the vocabulary doesn't know is kept as it appears on the page.

**value**
- Normalised:
  - dates as `YYYY-MM-DD`; ROC dates are converted (`040/11/09` → `1951-11-09`);
  - sex as `male`, `female` or `other`;
  - numbers in **one unit per label** (°C, kg, cm, mmHg, mg/dL), so 101 °F becomes `38.3`.
- Blood pressure stays one value, `144/100`.
- A glucose meal-time tag goes in the label (`Blood glucose (AC/PC/HS)`).
- Media rows point to the stored file (`sha256:…`).

**time**
- `nan` for persistent labels: Name, Sex, Birth date, National ID, MRN, Blood type, phone, address, …
- `YYYYMMDD` for a date only.
- `YYYYMMDDHHmm` in **UTC** for a date and time, so 14:00 Taipei time is stored as `0600`.
- Where a value's time comes from is set per field in the page's template (see **Page templates** below): fixed (`nan`), the date in another field of the page (填表日期, 醫囑日期 …), the row's time column in a table, or the capture time. The first draft links timed values to the form's date when the page has one.
- Readings with only a relative time ("4小時前") are skipped and listed in the preview.

**source**
- The site's origin, or `file:<name>` for imports.

**Uniqueness**
- One row per (patientId, label, time, source). `Medication` is the exception: its value is part of the key, so two drugs started at the same time are both kept.
- A re-capture of the same row is a duplicate and is skipped.
- A different value for the same key is shown as `old → new` and replaces the stored value only if you tick it.

## Install (unpacked)

1. `npm install`. This is only needed for tests, or to rebuild `extension/vendor/`; the vendor files are already built.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder.
4. To capture saved `.html` files, open the extension's **Details** page and turn on **Allow access to file URLs**.
5. Click the toolbar icon to open the side panel.

The extension ID is fixed by the `key` in the manifest: `obkilllebkjkeglikimoaigkpkopfekg`. You need it for the Google setup below.

## Daily use

### Page templates
Each page (a site's frame page; record numbers in the address don't matter) has **one template** that maps every value on it. The assumption is that a page's layout doesn't change.

1. **First visit:** the built-in rules read the page and make a **draft template**. A yellow banner says so. When you press **Save**, the draft is saved as the page's template. Rows you unticked are left out of it.
2. **After that:** the page is read **strictly by its template**. Only template fields are saved, under the labels the template gives them.
3. **New things on the page:** values the rules see that the template doesn't cover are listed as *"N values on this page aren't in the template → Review"*, and outlined on the page. **Add** them to the template, or **Ignore** them so they aren't offered again. Nothing outside the template is ever saved.
4. **Editing:** in the side panel, change a row's label, or choose **Remove from template**; **Teach** adds a field. In **Dashboard → Mappings** you can do the same on the page's saved sample. Changes made in the side panel are kept when you press **Save**, or **Save template** to keep them without saving data.

**Time links.** Each row shows a **⏱ chip** saying where its time comes from:

| Chip | Meaning |
|---|---|
| `⏱ fixed` | no time (`nan`); always so for personal details |
| `⏱ ← 填表日期` | the date in that field of the page |
| `⏱ own value` | the field is a date itself (e.g. 填表日期) |
| `⏱ ← column 測量時間` | each table row's own time cell |
| `⏱ capture time ⚠` | when you pressed Scan; usually not what you want for timed data |

Hover a chip to outline the value and its time source on the page. Click it to choose another: fixed, capture time, a date field, a table's time column, or **Pick the date on the page…**.

### Capture (side panel → Capture)
1. Open a patient page in the HIS and press **Scan page**. Every frame is read, including nested iframes, each by its own page template (or a draft of one).
2. The page gets coloured outlines:
   - **green**: recognised;
   - **amber**: unknown label;
   - **blue**: a table or list that was read;
   - **red**: out of range.
   Hover a row in the panel and its element is highlighted on the page; click an outline label to jump to its row.
3. In the panel, check the rows:
   - untick what you don't want;
   - edit a value;
   - map an unknown label using the dropdown (double-click a label to change it). The label goes into the page's template, and is also learned for drafts of other pages and for Fill;
   - check each row's ⏱ time chip.
4. Check the patient ID, then press **Save**.

**More capture tools**
- **Pick region**: capture only the part of the page you click.
- **Teach**: click a value, a form field or a tick box and give it a label. It becomes a field of the page's template.
  - A click on any tick box, radio button or tick-box picture, or on its text, teaches the **whole group**; its value is the ticked options.
  - It is found again by its position, and by the text before it if the layout shifts.
  - **Fill uses it too**: a field on a read-only page is found on the edit form by the text before it, and the other way round.
- **Screenshot** / **Pick media**: save the visible page, or an image, chart, audio clip or video.
- **AI extract**: Claude reads a masked copy of the page (see Privacy below). Its answer becomes **suggested changes to the page's template**: new fields, better labels, and the date each value belongs to. Each value is found on the page itself; you tick what to apply. Values are never saved from the AI's answer directly, so the page is read the same way every time. Values that aren't one element of the page are listed as not found.

### Fill another site's form (side panel → Fill)
1. Choose the patient, and optionally which date's vitals to use.
2. Open the target form and press **Scan form**. Badges show what would be written, already converted to that form's format:
   - dates as `YYYY-MM-DD`, `YYYY/MM/DD` or ROC `115/10/07`, including split year/month/day boxes;
   - 男/女 options and radio buttons chosen by meaning;
   - °F when the form asks for it;
   - systolic and diastolic in separate boxes when the form has two.
3. Fields that already have a value are kept unless you tick them.
4. Press **Fill**. **Undo** puts the old values back.
5. The extension never submits the form; you check it and submit it yourself.
6. **Teach** maps a form field or tick-box group the extension couldn't match. It works exactly like Teach in Capture, and Capture uses what you teach here too.

### Dashboard
- **Patients**: each patient's details, with differences between sources flagged; trend charts per vital (blood pressure as two lines); medications; a media gallery; all values with delete; merge two IDs.
- **Import**:
  - CSV, TSV and XLSX with any layout: you see the first 20 rows, choose a label for each column and see the 5-field result before importing. The mapping is remembered for files with the same columns.
  - Personal DB CSV, JSON or zip, and FHIR JSON.
  - Saved HTML pages, read exactly like a live page.
  - Media files.
- **Export**:
  - CSV with exactly the 5 columns, which opens directly in Excel or pandas;
  - JSON;
  - a FHIR R4 Bundle (Patient, LOINC-coded vital-sign Observations, blood pressure as a panel, MedicationStatement, Media);
  - with media included, any of these comes out as a zip.
- **Mappings**:
  - **Page templates**: one per page. Open one to see its **sample page**: a masked copy saved with the template (values and personal details replaced by `[labels]`, no scripts, nothing loaded from the network). It keeps the page's layout: all its stylesheets (other sites' ones are fetched when the template is saved) in their original order, and pictures as grey boxes of the same size. Fonts and background pictures from the network are left out. Every field is outlined: green value, violet personal detail, dashed blue time source, amber unknown label, grey not saved. Hover a value to see a dashed arrow to its time source.
  - **◂ Field list** opens the field list as a side panel beside the sample (hidden until you open it): label, the text it sits next to on the page, and its ⏱ time link. **Edit** changes the label, the time link (including **Pick the date in the sample page…**) or leaves the field out; for tables, which columns are saved and as what. **+ Add a field** lets you click an element of the sample. Fields added on the sample are matched to the live page the next time you scan it.
  - Learned labels (all sites or one site, and where they were learned), and fields taught in Fill.
  - Delete, export and import. The export includes templates and their masked samples.
- **Settings & backup**: backup, AI and privacy settings, and an audit log of everything sent to AI.

## Google Drive backup (optional)

**What it does**
- Every file is encrypted on your computer (AES-GCM, key from your passphrase via PBKDF2 at 310 000 rounds) before upload.
- Files go to the Drive folder **PersonalDB Backups**.
- The `drive.file` scope means the extension can only see files it created itself.

**When it runs**
- Checked daily. A backup runs only when the interval (weekly by default; daily, monthly or manual are also available) has passed **and** your data changed.
- Each media file is uploaded once, and the newest 8 snapshots are kept.
- The passphrase is kept only for the browser session. If it's missing, a 🔑 badge appears and the backup waits.
- **If you lose the passphrase, the backups cannot be opened.**

**Setup, once**
1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen (External, Testing) and add yourself as a test user.
3. Go to **Credentials → Create credentials → OAuth client ID**, choose type **Chrome Extension**, and enter the extension ID `obkilllebkjkeglikimoaigkpkopfekg`.
4. Put the client ID into `extension/manifest.json` → `oauth2.client_id`, then reload the extension.
5. In the dashboard, go to **Settings & backup**, enter a passphrase, turn the backup on and press **Back up now**.
6. **Restore from Drive…** lets you merge a backup into local data or replace local data with it.

## Privacy and AI extract

**AI extract is off** until you enable it in Settings with your own Anthropic API key. It sends a page to Claude (`claude-opus-5-5`) for layouts the rules can't read, including charts drawn as images.

Every request goes through the privacy gate in [extension/lib/redact.js](extension/lib/redact.js):

1. **Text, not raw HTML.** Only visible text is sent, with tables as text grids. Removed entirely: attributes, hidden inputs, scripts, comments, URLs, and the page title and address.
2. **Automatic masking.** Matches become placeholders such as `[NAME_1]`, `[ID_1]` and `[PHONE_1]`:
   - values next to sensitive labels (name, national ID, MRN, phone, address, email, birth date);
   - this patient's stored values, in other formats too (for example the ROC birth date, or the phone number without dashes);
   - patterns: Taiwan national IDs, phone numbers, emails, addresses, long numbers, and names after words like 病人 or 先生;
   - your own custom terms.
3. **Your review.** You see the exact text that will be sent.
   - **Amber** items are uncertain and need your decision.
   - Click any item to switch between masked and sent.
   - You can also select any other text to mask it.
   - Per category, choose in Settings: always mask, ask, or send.
4. **Screenshots** (optional). Known personal fields are blacked out, and you can draw more boxes yourself. You must tick "I checked the image" before it can be sent.
5. **Hard block.** If a national ID, phone number or email is still in the outgoing text and you didn't explicitly approve it, nothing is sent.
6. **Back to real values locally.** The reply contains only placeholders; they are swapped back to the real values in the side panel. The values are then looked up on the page and offered as changes to the page's template; nothing from the reply is saved as data.
7. **Audit log.** The last 20 payloads exactly as sent are kept locally, in **Settings → Audit log**.

## Development

```
npm test            # 81 tests: extraction, page templates (parity with the rules, strict reading, time links, sample pages), fill, export/FHIR/zip, crypto, backup, privacy gate, UI smoke
npm run check       # syntax check of every extension script
npm run build:vendor  # re-bundle @anthropic-ai/sdk and SheetJS into extension/vendor/
```

**Test pages**
- `tests/fixtures/` holds **synthetic** pages with fake people, copying the layouts of the target systems:
  - 康庭 measurement and medication lists;
  - the 居護系統 Angular forms;
  - the 智齡 resident profile;
  - the 照顧服務管理資訊平臺 case and assessment pages;
  - a referral form used to test filling.
- `tests/data/` holds real saved pages. It is **git-ignored because it contains real patient data**. `tests/real-pages.test.js` runs against it only when the folder exists, and checks counts and labels without printing any values.

**Layout**

| Path | What it is |
|---|---|
| `extension/lib/schema.js` | Vocabulary: canonical labels, synonyms, units, LOINC codes, plausible ranges |
| `extension/lib/core.js` | Label matching, ROC/UTC date parsing, value normalisation, table analysis, identity matching, deduplication |
| `extension/lib/dom.js` | Reads pages: tables, forms, label/value siblings, checkbox images, frames |
| `extension/lib/fill.js` | Autofill |
| `extension/lib/templates.js` | Finding a field again: selector, the text before it, its label text |
| `extension/lib/pagetpl.js` | Page templates: draft from the rules, strict reading, time links, "not in template", masked sample pages |
| `extension/lib/export.js` | Export and import: CSV, JSON, FHIR, zip |
| `extension/lib/backup.js`, `crypto.js` | Google Drive backup and its encryption |
| `extension/lib/redact.js`, `ai.js` | Privacy gate and Claude extract |
| `extension/content/agent.js` | In-page overlay, picker and fill (injected only when you press a button) |
| `extension/sidepanel/`, `extension/dashboard/` | The user interface |

**Adding your system's wording:** add synonyms in `schema.js`, or map labels in the side panel; learned labels are used for the drafts of new pages' templates and by Fill.
